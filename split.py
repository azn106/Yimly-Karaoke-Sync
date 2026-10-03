#!/usr/bin/env python3
"""
usersync split: standalone Demucs stem separation.

Reads JSON from argv[1], optionally writes status JSON to argv[2].

Request format:
{
    "audio":        "<path>",
    "out_dir":      "<path>",
    "model":        "htdemucs",      # htdemucs | htdemucs_ft | htdemucs_6s | mdx_extra | mdx
    "stems":        "all",           # "all" -> all stems  /  "vocals" -> 2-stem (vocals + no_vocals)
    "format":       "wav",           # wav | mp3 | flac
    "mp3_bitrate":  320,
    "shifts":       1,               # 0-10  (more = better quality, slower)
    "overlap":      0.25,            # 0.0-0.5
    "use_gpu":      true
}

Output is written to: <out_dir>/<model>/<basename>/<stem>.<format>

Status output (stderr):
    [PROG] <0-100> <msg>
    [INFO]/[WARN]/[ERR ]  diagnostics
"""

import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path

# Configure app-local model cache under <APP_ROOT>/models
_app_root = Path(__file__).resolve().parent
_models_dir = str(_app_root / "models")
os.environ.setdefault("TORCH_HOME", _models_dir)
os.environ.setdefault("HF_HOME", _models_dir)
os.environ.setdefault("XDG_CACHE_HOME", _models_dir)
os.environ.setdefault("TRANSFORMERS_CACHE", _models_dir)


def log(level, msg):
    sys.stderr.write(f"[{level}] {msg}\n")
    sys.stderr.flush()


def progress(pct, msg=""):
    sys.stderr.write(f"[PROG] {pct} {msg}\n")
    sys.stderr.flush()


def run_separation(req, status_path=None):
    audio_path  = req["audio"]
    out_dir     = req["out_dir"]
    model       = req.get("model",        "htdemucs")
    stems       = req.get("stems",        "all")
    fmt         = req.get("format",       "wav").lower()
    mp3_br      = int(req.get("mp3_bitrate", 320))
    shifts      = int(req.get("shifts",      1))
    overlap     = float(req.get("overlap",   0.25))
    want_gpu    = bool(req.get("use_gpu",   True))

    if not os.path.exists(audio_path):
        log("ERR ", f"audio not found: {audio_path}")
        res = {"ok": False, "error": "audio not found"}
        if status_path:
            Path(status_path).write_text(json.dumps(res))
        return res

    progress(2, "verifying mandatory CUDA acceleration")
    try:
        import torch
        import demucs.separate
    except ImportError as e:
        err_msg = f"missing dependency: {e}"
        log("ERR ", err_msg)
        log("ERR ", "Run setup_whisperx.bat to install PyTorch with CUDA and Demucs.")
        res = {
            "ok": False,
            "error": f"CUDA/RTX 3060 is required for audio separation but is unavailable: {err_msg}",
            "device": "none"
        }
        if status_path:
            Path(status_path).write_text(json.dumps(res))
        return res

    # ----------------------------------------------------
    # STRICT MANDATORY CUDA VALIDATION - NO CPU FALLBACK
    # ----------------------------------------------------
    cuda_valid = False
    cuda_err_detail = ""
    dev_name = ""
    vram_gb = 0.0

    try:
        if not torch.cuda.is_available():
            raise RuntimeError("torch.cuda.is_available() returned False")
        if torch.cuda.device_count() < 1:
            raise RuntimeError("torch.cuda.device_count() is 0")
        
        dev_name = torch.cuda.get_device_name(0)
        vram_gb = round(torch.cuda.get_device_properties(0).total_memory / 1e9, 2)

        # Execute real CUDA tensor operation and synchronize
        test_x = torch.ones((512, 512), device='cuda', dtype=torch.float32)
        test_y = torch.matmul(test_x, test_x)
        torch.cuda.synchronize()
        del test_x, test_y
        torch.cuda.empty_cache()
        cuda_valid = True
    except Exception as c_err:
        cuda_valid = False
        cuda_err_detail = str(c_err)

    if not cuda_valid:
        fail_msg = "CUDA/RTX 3060 is required for audio separation but is unavailable."
        log("ERR ", fail_msg)
        if cuda_err_detail:
            log("ERR ", f"Diagnostic detail: {cuda_err_detail}")
        log("ERR ", "Demucs CPU fallback is strictly disabled.")
        res = {
            "ok": False,
            "error": fail_msg,
            "cuda_error": cuda_err_detail,
            "device": "cuda",
        }
        if status_path:
            Path(status_path).write_text(json.dumps(res))
        return res

    device = "cuda"
    log("INFO", f"Audio device: CUDA — {dev_name} ({vram_gb} GB VRAM)")
    log("INFO", f"Selected device verified as: {device}. Real CUDA compute validated.")

    Path(out_dir).mkdir(parents=True, exist_ok=True)

    log("INFO", f"model={model}  stems={stems}  format={fmt}  shifts={shifts}  overlap={overlap}")

    cli = [
        "-n",          model,
        "-o",          out_dir,
        "--device",    "cuda",
        "--shifts",    str(shifts),
        "--overlap",   f"{overlap:.3f}",
    ]
    if stems == "vocals":
        cli.append("--two-stems=vocals")
    if fmt == "mp3":
        cli += ["--mp3", "--mp3-bitrate", str(mp3_br)]
    elif fmt == "flac":
        cli.append("--flac")
    cli.append(audio_path)

    progress(8, f"separating with {model} ({device})")
    t0 = time.time()
    try:
        demucs.separate.main(cli)
    except SystemExit:
        pass
    except Exception as e:
        log("ERR ", f"demucs failed: {e}")
        log("ERR ", traceback.format_exc())
        res = {"ok": False, "error": str(e)}
        if status_path:
            Path(status_path).write_text(json.dumps(res))
        return res
    elapsed = time.time() - t0
    log("INFO", f"separation done in {elapsed:.1f}s")

    basename  = os.path.splitext(os.path.basename(audio_path))[0]
    track_dir = os.path.join(out_dir, model, basename)
    outputs = []
    if os.path.isdir(track_dir):
        for f in sorted(os.listdir(track_dir)):
            outputs.append(os.path.join(track_dir, f))
            log("INFO", f"  + {f}")
    if not outputs:
        log("WARN", f"no stems found in {track_dir}")

    progress(100, "done")
    res = {
        "ok":       True,
        "out_dir":  track_dir,
        "stems":    outputs,
        "device":   "cuda",
        "gpu_name": dev_name,
        "vram_gb":  vram_gb,
        "elapsed":  elapsed,
    }
    if status_path:
        Path(status_path).write_text(json.dumps(res))
    return res


def worker_loop():
    log("INFO", "Starting Demucs Persistent Worker Process...")
    try:
        import torch
        import demucs.separate
    except ImportError as e:
        log("ERR ", f"Demucs worker missing dependency: {e}")
        sys.exit(1)

    log("INFO", "Demucs Persistent Worker initialized. Awaiting requests...")
    sys.stdout.write("[WORKER_READY]\n")
    sys.stdout.flush()

    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
        except Exception as e:
            log("ERR ", f"Worker received invalid JSON command: {e}")
            res = {"ok": False, "error": f"Invalid JSON command: {e}"}
            sys.stdout.write(f"[WORKER_RESULT] {json.dumps(res)}\n")
            sys.stdout.flush()
            continue

        req_file = cmd.get("request_file")
        status_file = cmd.get("status_file")

        if req_file and os.path.exists(req_file):
            try:
                with open(req_file, "r", encoding="utf-8") as f:
                    req = json.load(f)
            except Exception as req_err:
                log("ERR ", f"Failed to load request file: {req_err}")
                res = {"ok": False, "error": f"Invalid request file: {req_err}"}
                if status_file:
                    Path(status_file).write_text(json.dumps(res))
                sys.stdout.write(f"[WORKER_RESULT] {json.dumps(res)}\n")
                sys.stdout.flush()
                continue
        else:
            req = cmd

        try:
            res = run_separation(req, status_file)
        except Exception as job_err:
            log("ERR ", f"Worker error processing job: {job_err}")
            log("ERR ", traceback.format_exc())
            res = {"ok": False, "error": str(job_err)}
            if status_file:
                try:
                    Path(status_file).write_text(json.dumps(res))
                except Exception:
                    pass

        sys.stdout.write(f"[WORKER_RESULT] {json.dumps(res)}\n")
        sys.stdout.flush()

        try:
            if 'torch' in sys.modules and torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        worker_loop()
        return

    ap = argparse.ArgumentParser()
    ap.add_argument("request")
    ap.add_argument("status", nargs="?")
    args = ap.parse_args()

    with open(args.request, "r", encoding="utf-8") as f:
        req = json.load(f)

    res = run_separation(req, args.status)
    if not res.get("ok"):
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        log("ERR ", f"fatal: {e}")
        log("ERR ", traceback.format_exc())
        sys.exit(2)
