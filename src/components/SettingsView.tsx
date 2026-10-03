import React, { useState, useEffect } from 'react';
import { 
  Settings as SettingsIcon, 
  Save, 
  HardDrive, 
  Cpu, 
  Zap, 
  Layers, 
  Music, 
  FileText, 
  Check, 
  Radio,
  Clock
} from 'lucide-react';
import { AppSettings, SystemStatus } from '../types.js';

function formatLeadInPreview(ms: number): string {
  const safeMs = isNaN(ms) ? 500 : Math.max(0, Math.min(5000, ms));
  const leadInSec = safeMs / 1000;
  const outerSec = Math.max(0, Math.round((16.49 - leadInSec) * 100) / 100);
  const m = Math.floor(outerSec / 60);
  const s = outerSec % 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

interface SettingsViewProps {
  settings: AppSettings | null;
  status: SystemStatus | null;
  onSaveSettings: (newSettings: Partial<AppSettings>) => Promise<void>;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  status,
  onSaveSettings,
}) => {
  const [form, setForm] = useState<AppSettings | null>(settings);
  const [saving, setSaving] = useState<boolean>(false);
  const [savedSuccess, setSavedSuccess] = useState<boolean>(false);

  useEffect(() => {
    if (settings) {
      setForm(settings);
    }
  }, [settings]);

  if (!form) {
    return <div className="p-8 text-center text-slate-500 text-xs">Loading configuration...</div>;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSaveSettings({ ...form, isConfigured: true });
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2500);
    } finally {
      setSaving(false);
    }
  };

  const cudaAvailable = status?.pythonInfo?.cudaAvailable ?? false;
  const gpuName = status?.pythonInfo?.deviceName || 'No NVIDIA CUDA GPU detected';

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3.5 sm:gap-4 p-4 sm:p-5 rounded-2xl bg-[#1E293B] border border-slate-800 shadow-sm">
        <div>
          <h2 className="text-sm sm:text-base font-bold text-slate-100 flex items-center gap-2.5">
            <SettingsIcon className="w-5 h-5 text-[#FF4FA3]" />
            <span>Yimly Sync Engine Settings</span>
          </h2>
          <p className="text-[11px] sm:text-xs text-slate-400 mt-1">
            Configure Demucs instrumental generation, Musixmatch lyrics synchronization, and system parameters.
          </p>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="w-full sm:w-auto flex items-center justify-center space-x-2 px-4 py-2.5 sm:py-2 rounded-xl bg-[#FF4FA3] hover:bg-[#ff3d99] text-white text-xs font-semibold shadow-lg shadow-[#FF4FA3]/25 transition active:scale-95 disabled:opacity-50 min-h-[40px] sm:min-h-0"
        >
          {savedSuccess ? (
            <>
              <Check className="w-4 h-4 text-emerald-300" />
              <span>Configuration Saved!</span>
            </>
          ) : (
            <>
              <Save className="w-4 h-4" />
              <span>{saving ? 'Saving...' : 'Save Configuration'}</span>
            </>
          )}
        </button>
      </div>

      {/* 1. DIRECTORIES AND PATHS */}
      <div className="p-4 sm:p-6 rounded-2xl bg-[#1E293B] border border-slate-800 space-y-4 shadow-sm">
        <div className="flex items-center space-x-3 pb-3 border-b border-slate-800">
          <HardDrive className="w-4 h-4 text-[#FF4FA3]" />
          <h3 className="text-sm font-bold text-slate-200">Paths & Configuration</h3>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">
              Watched Media Folder
            </label>
            <input
              type="text"
              value={form.mediaRoot}
              onChange={e => setForm({ ...form, mediaRoot: e.target.value })}
              className="w-full px-3.5 py-2.5 bg-[#0F172A] border border-slate-800 rounded-xl text-xs font-mono text-slate-100 focus:outline-none focus:border-[#FF4FA3]"
              placeholder="F:\Music"
              required
            />
            <p className="text-[11px] text-slate-500">
              * Note: Generated <code className="text-slate-400 font-mono">Song (Instrumental).ext</code>, <code className="text-slate-400 font-mono">Song.elrc.lrc</code>, and <code className="text-slate-400 font-mono">Song.lrc</code> are placed beside the original file.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">
              Demucs Models Folder
            </label>
            <input
              type="text"
              value={form.modelsDir}
              onChange={e => setForm({ ...form, modelsDir: e.target.value })}
              className="w-full px-3.5 py-2.5 bg-[#0F172A] border border-slate-800 rounded-xl text-xs font-mono text-slate-100 focus:outline-none focus:border-[#FF4FA3]"
              placeholder="Auto-calculated (models/)"
            />
            <p className="text-[11px] text-slate-500">
              Directory where Torch Demucs models are cached (sets TORCH_HOME).
            </p>
          </div>
        </div>
      </div>

      {/* 2. MULTI-PROVIDER LYRICS RETRIEVAL ENGINE */}
      <div className="p-6 rounded-2xl bg-[#1E293B] border border-slate-800 space-y-4 shadow-sm">
        <div className="flex items-center space-x-3 pb-3 border-b border-slate-800">
          <FileText className="w-4 h-4 text-[#FF4FA3]" />
          <h3 className="text-sm font-bold text-slate-200">Lyrics Synchronization & Multi-Provider Engine</h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="p-4 rounded-xl bg-[#0F172A] border border-slate-800 space-y-2">
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <span className="text-xs font-semibold text-slate-200 block">Word-Synced Richsync (eLRC)</span>
                <span className="text-[11px] text-slate-400">Generates <code className="text-pink-300 font-mono">.elrc.lrc</code> with word-level timestamps</span>
              </div>
              <input
                type="checkbox"
                checked={form.lyrics?.fetchElrc ?? true}
                onChange={e => setForm({
                  ...form,
                  lyrics: { ...(form.lyrics || { fetchElrc: true, fetchLrc: true, overwriteExisting: false, elrcLineLeadInMs: 500 }), fetchElrc: e.target.checked }
                })}
                className="w-4 h-4 rounded bg-[#1E293B] border-slate-700 text-[#FF4FA3] focus:ring-[#FF4FA3]"
              />
            </label>
          </div>

          <div className="p-4 rounded-xl bg-[#0F172A] border border-slate-800 space-y-2">
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <span className="text-xs font-semibold text-slate-200 block">Standard Subtitles (LRC)</span>
                <span className="text-[11px] text-slate-400">Generates standard <code className="text-pink-300 font-mono">.lrc</code> with line-level timestamps</span>
              </div>
              <input
                type="checkbox"
                checked={form.lyrics?.fetchLrc ?? true}
                onChange={e => setForm({
                  ...form,
                  lyrics: { ...(form.lyrics || { fetchElrc: true, fetchLrc: true, overwriteExisting: false, elrcLineLeadInMs: 500 }), fetchLrc: e.target.checked }
                })}
                className="w-4 h-4 rounded bg-[#1E293B] border-slate-700 text-[#FF4FA3] focus:ring-[#FF4FA3]"
              />
            </label>
          </div>
        </div>

        {/* eLRC Line Show Lead-In Setting */}
        <div className="p-4 rounded-xl bg-[#0F172A] border border-slate-800 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 text-[#FF4FA3]" />
                <label className="text-xs font-semibold text-slate-200">
                  eLRC Line Show Lead-In
                </label>
              </div>
              <p className="text-[11px] text-slate-400">
                How many milliseconds before the first word an eLRC line appears.
              </p>
            </div>
            <div className="flex items-center gap-2 self-start sm:self-auto">
              <input
                type="number"
                min={0}
                max={5000}
                step={50}
                value={form.lyrics?.elrcLineLeadInMs ?? 500}
                onChange={e => {
                  const val = parseInt(e.target.value, 10);
                  setForm({
                    ...form,
                    lyrics: {
                      ...(form.lyrics || { fetchElrc: true, fetchLrc: true, overwriteExisting: false, elrcLineLeadInMs: 500 }),
                      elrcLineLeadInMs: isNaN(val) ? 500 : Math.max(0, Math.min(5000, val)),
                    },
                  });
                }}
                className="w-24 px-3 py-1.5 bg-[#1E293B] border border-slate-700 rounded-lg text-xs font-mono text-slate-100 text-right focus:outline-none focus:border-[#FF4FA3]"
              />
              <span className="text-xs text-slate-400 font-mono font-medium">ms</span>
            </div>
          </div>

          {/* Dynamic Example Preview */}
          <div className="p-2.5 rounded-lg bg-[#1E293B]/70 border border-slate-800 text-[11px] text-slate-400 flex flex-wrap items-center justify-between gap-2 font-mono">
            <span className="text-slate-500">Preview (First word at 00:16.49):</span>
            <span>
              Line appears at: <strong className="text-[#FF4FA3] font-semibold">[{formatLeadInPreview(form.lyrics?.elrcLineLeadInMs ?? 500)}]</strong>
            </span>
          </div>
        </div>

        {/* Multi-Provider Priority & Status */}
        <div className="p-4 rounded-xl bg-[#0F172A] border border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-200 flex items-center gap-2">
              <Radio className="w-4 h-4 text-[#FF4FA3]" />
              Multi-Provider Fallback Priority Chain
            </span>
            <span className="text-[10px] text-slate-400 font-mono uppercase bg-slate-800 px-2 py-0.5 rounded">
              Automatic Fallback
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <div className="p-2.5 rounded-lg bg-[#1E293B]/80 border border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-[#FF4FA3]/20 text-[#FF4FA3] font-bold text-[10px] flex items-center justify-center font-mono">1</span>
                <div>
                  <div className="font-semibold text-slate-200">NetEase Cloud Music</div>
                  <div className="text-[10px] text-slate-400">YRC (Native EAPI AES-128-ECB)</div>
                </div>
              </div>
              <span className="text-[10px] font-mono text-emerald-400 font-semibold bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/40">Primary</span>
            </div>

            <div className="p-2.5 rounded-lg bg-[#1E293B]/80 border border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-slate-700 text-slate-300 font-bold text-[10px] flex items-center justify-center font-mono">2</span>
                <div>
                  <div className="font-semibold text-slate-200">QQ Music</div>
                  <div className="text-[10px] text-slate-400">QRC (Native TripleDES + Zlib)</div>
                </div>
              </div>
              <span className="text-[10px] font-mono text-sky-400 bg-sky-950/60 px-2 py-0.5 rounded border border-sky-800/40">Fallback 1</span>
            </div>

            <div className="p-2.5 rounded-lg bg-[#1E293B]/80 border border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-slate-700 text-slate-300 font-bold text-[10px] flex items-center justify-center font-mono">3</span>
                <div>
                  <div className="font-semibold text-slate-200">Kugou Music</div>
                  <div className="text-[10px] text-slate-400">KRC (Native XOR + Zlib)</div>
                </div>
              </div>
              <span className="text-[10px] font-mono text-amber-400 bg-amber-950/60 px-2 py-0.5 rounded border border-amber-800/40">Fallback 2</span>
            </div>

            <div className="p-2.5 rounded-lg bg-[#1E293B]/80 border border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-slate-700 text-slate-300 font-bold text-[10px] flex items-center justify-center font-mono">4</span>
                <div>
                  <div className="font-semibold text-slate-200">Musixmatch</div>
                  <div className="text-[10px] text-slate-400">Richsync (Official Desktop Client)</div>
                </div>
              </div>
              <span className="text-[10px] font-mono text-violet-400 bg-violet-950/60 px-2 py-0.5 rounded border border-violet-800/40">Fallback 3</span>
            </div>
          </div>
        </div>
      </div>

      {/* 3. DEMUCS STEM SEPARATION SETTINGS */}
      <div className="p-6 rounded-2xl bg-[#1E293B] border border-slate-800 space-y-4 shadow-sm">
        <div className="flex items-center space-x-3 pb-3 border-b border-slate-800">
          <Layers className="w-4 h-4 text-[#FF4FA3]" />
          <h3 className="text-sm font-bold text-slate-200">Demucs Instrumental Generation (<code className="text-xs text-[#FF4FA3] font-mono">split.py</code>)</h3>
        </div>

        <p className="text-xs text-slate-400">
          Demucs is only executed if an existing matching instrumental (e.g. <code className="text-slate-300 font-mono">Song (Instrumental).ext</code>) is not already found.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Model */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">Demucs Model</label>
            <select
              value={form.demucs.model}
              onChange={e => setForm({
                ...form,
                demucs: { ...form.demucs, model: e.target.value as any }
              })}
              className="w-full px-3.5 py-2.5 bg-[#0F172A] border border-slate-800 rounded-xl text-xs font-mono text-slate-100 focus:outline-none focus:border-[#FF4FA3]"
            >
              <option value="htdemucs">htdemucs (Fast & High Quality - Recommended)</option>
              <option value="htdemucs_ft">htdemucs_ft (Fine-tuned, highest quality)</option>
              <option value="htdemucs_6s">htdemucs_6s (6-stem model)</option>
              <option value="mdx_extra">mdx_extra (MDX architecture)</option>
              <option value="mdx">mdx (MDX base)</option>
            </select>
          </div>

          {/* MP3 Bitrate */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">MP3 Bitrate (kbps)</label>
            <select
              value={form.demucs.mp3Bitrate}
              onChange={e => setForm({
                ...form,
                demucs: { ...form.demucs, mp3Bitrate: parseInt(e.target.value, 10) }
              })}
              className="w-full px-3.5 py-2.5 bg-[#0F172A] border border-slate-800 rounded-xl text-xs font-mono text-slate-100 focus:outline-none focus:border-[#FF4FA3]"
            >
              <option value="320">320 kbps (High Quality)</option>
              <option value="256">256 kbps</option>
              <option value="192">192 kbps</option>
            </select>
          </div>

          {/* Demucs GPU */}
          <div className="space-y-1.5 flex items-center pt-5">
            <label className="flex items-center space-x-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.demucs.useGpu}
                onChange={e => setForm({
                  ...form,
                  demucs: { ...form.demucs, useGpu: e.target.checked }
                })}
                className="w-4 h-4 rounded bg-[#0F172A] border-slate-700 text-[#FF4FA3] focus:ring-[#FF4FA3]"
              />
              <span>Use GPU for Demucs</span>
            </label>
          </div>
        </div>
      </div>

      {/* 4. GPU & ENVIRONMENT */}
      <div className="p-6 rounded-2xl bg-[#1E293B] border border-slate-800 space-y-4 shadow-sm">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center space-x-3">
            <Zap className="w-4 h-4 text-[#FF4FA3]" />
            <h3 className="text-sm font-bold text-slate-200">Hardware Acceleration</h3>
          </div>
          <div className="flex items-center space-x-2.5">
            <span className="text-xs text-slate-400">Enable Global GPU</span>
            <input
              type="checkbox"
              checked={form.useGpu}
              onChange={e => setForm({ ...form, useGpu: e.target.checked })}
              className="w-4 h-4 rounded bg-[#0F172A] border-slate-700 text-[#FF4FA3] focus:ring-[#FF4FA3]"
            />
          </div>
        </div>

        <div className="p-3.5 rounded-xl bg-[#0F172A] border border-slate-800 text-xs flex items-center justify-between">
          <div>
            <span className="text-slate-400">Detected PyTorch Hardware: </span>
            <strong className={cudaAvailable ? 'text-emerald-400 font-mono' : 'text-amber-400 font-mono'}>
              {gpuName}
            </strong>
          </div>
          {status?.pythonInfo?.vramGb ? (
            <span className="text-[11px] font-mono text-[#FF4FA3] bg-[#FF4FA3]/10 px-2 py-0.5 rounded border border-[#FF4FA3]/20">
              VRAM: {status.pythonInfo.vramGb} GB
            </span>
          ) : null}
        </div>
      </div>

      {/* 5. BINARY PATHS */}
      <div className="p-6 rounded-2xl bg-[#1E293B] border border-slate-800 space-y-4 shadow-sm">
        <div className="flex items-center space-x-3 pb-3 border-b border-slate-800">
          <Cpu className="w-4 h-4 text-slate-400" />
          <h3 className="text-sm font-bold text-slate-200">Subprocess Environment & Binary Paths</h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5 sm:col-span-2">
            <label className="block text-xs font-medium text-slate-300">FFmpeg Executable Path</label>
            <input
              type="text"
              value={form.ffmpegPath}
              onChange={e => setForm({ ...form, ffmpegPath: e.target.value })}
              className="w-full px-3.5 py-2.5 bg-[#0F172A] border border-slate-800 rounded-xl text-xs font-mono text-slate-100 focus:outline-none focus:border-[#FF4FA3]"
              placeholder="ffmpeg"
            />
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <label className="block text-xs font-medium text-slate-300">Temporary Working Directory</label>
            <input
              type="text"
              value={form.tempDir}
              onChange={e => setForm({ ...form, tempDir: e.target.value })}
              className="w-full px-3.5 py-2.5 bg-[#0F172A] border border-slate-800 rounded-xl text-xs font-mono text-slate-100 focus:outline-none focus:border-[#FF4FA3]"
            />
            <p className="text-[10px] text-slate-500">
              * Demucs intermediate files and audio conversions are isolated here and automatically cleaned after each job.
            </p>
          </div>
        </div>
      </div>
    </form>
  );
};
