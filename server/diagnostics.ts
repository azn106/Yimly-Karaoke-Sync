import { exec, spawn } from 'child_process';
import { getSettings } from './config.js';
import { SystemStatus } from '../src/types.js';
import { getMusixmatchToken } from './musixmatch.js';

export interface DiagnosticsData {
  python: SystemStatus['pythonInfo'];
  ffmpeg: SystemStatus['ffmpegInfo'];
  musixmatch?: SystemStatus['musixmatchInfo'];
}

let cachedDiagnostics: DiagnosticsData | null = null;
let lastDiagnosticsTime = 0;
let inFlightDiagnostics: Promise<DiagnosticsData> | null = null;
const CACHE_TTL_MS = 60000; // Cache for 60 seconds

export async function runDiagnostics(forceRefresh = false): Promise<DiagnosticsData> {
  const now = Date.now();
  if (!forceRefresh && cachedDiagnostics && (now - lastDiagnosticsTime < CACHE_TTL_MS)) {
    return cachedDiagnostics;
  }

  if (inFlightDiagnostics) {
    return inFlightDiagnostics;
  }

  inFlightDiagnostics = (async () => {
    try {
      const result = await executeDiagnostics();
      cachedDiagnostics = result;
      lastDiagnosticsTime = Date.now();
      return result;
    } finally {
      inFlightDiagnostics = null;
    }
  })();

  return inFlightDiagnostics;
}

async function executeDiagnostics(): Promise<DiagnosticsData> {
  const settings = getSettings();
  const pythonPath = settings.pythonPath || 'python3';
  const ffmpegPath = settings.ffmpegPath || 'ffmpeg';

  let pythonInfo: SystemStatus['pythonInfo'] = {
    available: false,
    version: '',
    hasTorch: false,
    cudaAvailable: false,
    deviceCount: 0,
    hasDemucs: false,
    pythonPath: pythonPath,
    splitScriptPath: settings.splitScriptPath || '',
    mediaRoot: settings.mediaRoot || '',
    modelsDir: settings.modelsDir || '',
  };

  let ffmpegInfo: SystemStatus['ffmpegInfo'] = {
    available: false,
    hasFfprobe: false,
    version: '',
  };

  let musixmatchInfo: SystemStatus['musixmatchInfo'] = {
    authenticated: false,
  };

  // Run checks concurrently without blocking event loop
  const [pyResult, ffResult, mmToken] = await Promise.all([
    checkPython(pythonPath),
    checkFfmpeg(ffmpegPath),
    getMusixmatchToken().catch(() => null),
  ]);

  pythonInfo = { ...pythonInfo, ...pyResult };
  ffmpegInfo = { ...ffmpegInfo, ...ffResult };

  if (mmToken) {
    musixmatchInfo = {
      authenticated: true,
      tokenPreview: `${mmToken.substring(0, 8)}...${mmToken.substring(mmToken.length - 4)}`,
    };
  }

  return { python: pythonInfo, ffmpeg: ffmpegInfo, musixmatch: musixmatchInfo };
}

function checkPython(pythonPath: string): Promise<Partial<SystemStatus['pythonInfo']>> {
  return new Promise((resolve) => {
    const pyScript = `
import sys, json, time
info = {"available": True, "version": sys.version.split()[0]}
try:
    import torch
    info["hasTorch"] = True
    info["cudaAvailable"] = torch.cuda.is_available()
    info["deviceCount"] = torch.cuda.device_count()
    if info["cudaAvailable"] and info["deviceCount"] > 0:
        info["deviceName"] = torch.cuda.get_device_name(0)
        info["vramGb"] = round(torch.cuda.get_device_properties(0).total_memory / 1e9, 2)
        info["cudaVersion"] = getattr(torch.version, 'cuda', 'unknown')
        try:
            info["cudnnVersion"] = str(torch.backends.cudnn.version()) if torch.backends.cudnn.is_available() else 'disabled'
        except Exception:
            info["cudnnVersion"] = 'unknown'
        
        # Real tensor allocation & compute verification on RTX 3060
        try:
            t0 = time.time()
            x = torch.ones((512, 512), device='cuda', dtype=torch.float32)
            y = torch.matmul(x, x)
            torch.cuda.synchronize()
            del x, y
            torch.cuda.empty_cache()
            info["tensorVerified"] = True
        except Exception as te:
            info["tensorVerified"] = False
            info["tensorError"] = str(te)
    else:
        info["tensorVerified"] = False
except Exception as e:
    info["hasTorch"] = False
    info["torchError"] = str(e)

try:
    import demucs
    info["hasDemucs"] = True
except Exception:
    info["hasDemucs"] = False

print("###JSON_START###" + json.dumps(info) + "###JSON_END###")
`;

    let stdout = '';
    let settled = false;

    const proc = spawn(pythonPath, ['-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill('SIGKILL'); } catch {}
        resolve({
          available: false,
          version: 'Python check timed out',
        });
      }
    }, 8000);

    proc.stdin.write(pyScript);
    proc.stdin.end();

    proc.stdout.on('data', (d) => { stdout += d.toString(); });

    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          available: false,
          version: err.message || 'Python not found',
        });
      }
    });

    proc.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const match = stdout.match(/###JSON_START###(.*?)###JSON_END###/);
        if (match && match[1]) {
          try {
            const parsed = JSON.parse(match[1]);
            resolve(parsed);
            return;
          } catch {}
        }
        resolve({
          available: false,
          version: 'Could not parse Python info',
        });
      }
    });
  });
}

function checkFfmpeg(ffmpegPath: string): Promise<SystemStatus['ffmpegInfo']> {
  return new Promise((resolve) => {
    exec(`${ffmpegPath} -version`, { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve({
          available: false,
          hasFfprobe: false,
          version: err?.message || 'FFmpeg not found',
        });
        return;
      }

      const firstLine = stdout.split('\n')[0] || '';

      exec(`ffprobe -version`, { timeout: 4000 }, (probeErr, probeOut) => {
        exec(`${ffmpegPath} -hwaccels`, { timeout: 4000 }, (hwErr, hwOut) => {
          const hwText = hwOut || '';
          const hasCudaHwaccel = hwText.includes('cuda') || hwText.includes('nvdec') || hwText.includes('cuvid');
          
          resolve({
            available: true,
            hasFfprobe: !probeErr && Boolean(probeOut),
            version: firstLine,
            hasCudaHwaccel,
            audioEncoders: ['flac', 'libmp3lame', 'aac', 'pcm_s16le'],
          });
        });
      });
    });
  });
}

export interface CudaPreflightResult {
  ready: boolean;
  deviceName?: string;
  vramGb?: number;
  cudaVersion?: string;
  tensorVerified: boolean;
  error?: string;
}

export async function verifyCudaGpu(pythonPath?: string): Promise<CudaPreflightResult> {
  const py = pythonPath || getSettings().pythonPath || 'python3';
  const pyInfo = await checkPython(py);

  if (!pyInfo.available) {
    return {
      ready: false,
      tensorVerified: false,
      error: pyInfo.version || 'Python interpreter is unavailable',
    };
  }

  if (!pyInfo.hasTorch) {
    return {
      ready: false,
      tensorVerified: false,
      error: pyInfo.torchError || 'PyTorch is not installed in the Python environment',
    };
  }

  if (!pyInfo.cudaAvailable || !pyInfo.deviceCount || pyInfo.deviceCount < 1) {
    return {
      ready: false,
      tensorVerified: false,
      error: 'torch.cuda.is_available() is False or no CUDA devices were detected (deviceCount == 0)',
    };
  }

  if (!pyInfo.tensorVerified) {
    return {
      ready: false,
      tensorVerified: false,
      deviceName: pyInfo.deviceName,
      vramGb: pyInfo.vramGb,
      error: pyInfo.tensorError || 'Real CUDA tensor allocation and matmul execution failed on device 0',
    };
  }

  return {
    ready: true,
    deviceName: pyInfo.deviceName,
    vramGb: pyInfo.vramGb,
    cudaVersion: pyInfo.cudaVersion,
    tensorVerified: true,
  };
}

export async function runLiveGpuAudit(): Promise<{
  timestamp: number;
  cudaAvailable: boolean;
  deviceName?: string;
  vramGb?: number;
  tensorVerified: boolean;
  workloadBreakdown: {
    demucsStemSeparation: { supportsGpu: boolean; deviceTarget: string; explanation: string };
    ctcForcedAlignment: { supportsGpu: boolean; deviceTarget: string; explanation: string };
    ffmpegAudioEncoding: { supportsGpu: boolean; deviceTarget: string; explanation: string };
    lyricsRetrieval: { supportsGpu: boolean; deviceTarget: string; explanation: string };
  };
  details: any;
}> {
  const diag = await runDiagnostics(true);
  const py = diag.python;
  const isCuda = Boolean(py?.cudaAvailable && py?.deviceCount && py.deviceCount > 0 && py?.tensorVerified);

  return {
    timestamp: Date.now(),
    cudaAvailable: isCuda,
    deviceName: py?.deviceName,
    vramGb: py?.vramGb,
    tensorVerified: Boolean(py?.tensorVerified),
    workloadBreakdown: {
      demucsStemSeparation: {
        supportsGpu: true,
        deviceTarget: isCuda ? 'cuda (NVIDIA RTX 3060)' : 'MANDATORY CUDA REQUIRED (CPU Fallback Disabled)',
        explanation: 'Deep ConvNet/Transformer model in PyTorch. CUDA is strictly mandatory with zero CPU fallback.',
      },
      ctcForcedAlignment: {
        supportsGpu: true,
        deviceTarget: isCuda ? 'cuda (float16)' : 'MANDATORY CUDA REQUIRED (CPU Fallback Disabled)',
        explanation: 'Acoustic forced alignment CTC model via CTranslate2/PyTorch with FP16. CUDA mandatory.',
      },
      ffmpegAudioEncoding: {
        supportsGpu: false,
        deviceTarget: 'cpu',
        explanation: 'Audio compression (FLAC, MP3, AAC) is CPU-bound. NVIDIA NVENC hardware ASICs only encode video; audio encoders are CPU-only.',
      },
      lyricsRetrieval: {
        supportsGpu: false,
        deviceTarget: 'network',
        explanation: 'Network REST API requests to NetEase, QQ Music, Kugou, and Musixmatch.',
      },
    },
    details: diag,
  };
}

