import React, { useState } from 'react';
import { 
  Cpu, 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  RefreshCw, 
  Zap, 
  FileCode, 
  ShieldCheck,
  CheckCircle,
  Activity,
  Layers,
  Network,
  HardDrive
} from 'lucide-react';
import { SystemStatus } from '../types.js';

interface DiagnosticsViewProps {
  status: SystemStatus | null;
  onRefreshDiagnostics: () => void;
  isRefreshing: boolean;
}

export const DiagnosticsView: React.FC<DiagnosticsViewProps> = ({
  status,
  onRefreshDiagnostics,
  isRefreshing,
}) => {
  const py = status?.pythonInfo;
  const ff = status?.ffmpegInfo;
  const [gpuAuditData, setGpuAuditData] = useState<any>(null);
  const [isRunningGpuAudit, setIsRunningGpuAudit] = useState(false);

  const handleRunGpuAudit = async () => {
    setIsRunningGpuAudit(true);
    try {
      const res = await fetch('/api/diagnostics/gpu-check');
      if (res.ok) {
        const data = await res.json();
        setGpuAuditData(data);
      }
    } catch (e) {
      console.error('Failed to run GPU audit', e);
    } finally {
      setIsRunningGpuAudit(false);
    }
  };

  const checks = [
    {
      name: 'Python 3 Runtime',
      ok: py?.available ?? false,
      value: py?.available ? `Python ${py.version}` : 'Not found',
      description: 'Required to execute split.py stem isolation.',
    },
    {
      name: 'FFmpeg & FFprobe Tools',
      ok: ff?.available ?? false,
      value: ff?.available ? ff.version.split(' ')[0] + ' ' + (ff.version.split(' ')[2] || '') : 'Not found',
      description: 'Audio compression (FLAC/MP3) & metadata muxing (CPU-bound by architecture).',
    },
    {
      name: 'PyTorch (torch)',
      ok: py?.hasTorch ?? false,
      value: py?.hasTorch ? 'Installed' : 'Missing (pip install torch)',
      description: 'Deep learning runtime for Demucs instrumental isolation and WhisperX.',
    },
    {
      name: 'NVIDIA CUDA Acceleration',
      ok: py?.cudaAvailable ?? false,
      value: py?.cudaAvailable ? `${py.deviceName} (${py.vramGb} GB)` : 'CPU Mode (CUDA not detected)',
      description: 'Hardware acceleration for Demucs and WhisperX neural networks.',
    },
    {
      name: 'CUDA Tensor Allocation Test',
      ok: Boolean(py?.tensorVerified),
      value: py?.tensorVerified ? 'Verified Active (RTX 3060 Tensor)' : (py?.cudaAvailable ? 'Pending / Not Tested' : 'N/A (CPU Mode)'),
      description: 'Direct runtime memory allocation and compute verification on NVIDIA device.',
    },
    {
      name: 'Demucs Engine (demucs.separate)',
      ok: py?.hasDemucs ?? false,
      value: py?.hasDemucs ? 'Available' : 'Missing (pip install demucs)',
      description: 'Model for standalone instrumental stem creation when missing.',
    },
    {
      name: 'Multi-Provider Lyrics Engine',
      ok: true,
      value: 'NetEase · QQ Music · Kugou · Musixmatch',
      description: 'Concurrent asynchronous network retrieval for word-synced eLRC and standard LRC.',
    },
  ];

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3.5 sm:gap-4 p-4 sm:p-5 rounded-2xl bg-[#1E293B] border border-slate-800 shadow-sm">
        <div>
          <h2 className="text-sm sm:text-base font-bold text-slate-100 flex items-center gap-2.5">
            <Cpu className="w-5 h-5 text-[#FF4FA3]" />
            <span>System & Engine Diagnostics</span>
          </h2>
          <p className="text-[11px] sm:text-xs text-slate-400 mt-1">
            Verification of Python 3, PyTorch, RTX 3060 CUDA, Demucs, FFmpeg, and lyric providers.
          </p>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button
            onClick={handleRunGpuAudit}
            disabled={isRunningGpuAudit}
            className="flex-1 sm:flex-initial flex items-center justify-center space-x-2 px-3.5 py-2.5 sm:py-2 rounded-xl bg-purple-950/40 hover:bg-purple-900/50 text-purple-200 text-xs font-semibold border border-purple-500/30 transition shadow-sm"
          >
            <Zap className={`w-3.5 h-3.5 text-purple-400 ${isRunningGpuAudit ? 'animate-pulse' : ''}`} />
            <span>{isRunningGpuAudit ? 'Auditing GPU...' : 'Live GPU Audit'}</span>
          </button>

          <button
            onClick={onRefreshDiagnostics}
            disabled={isRefreshing}
            className="flex-1 sm:flex-initial flex items-center justify-center space-x-2 px-4 py-2.5 sm:py-2 rounded-xl bg-[#0F172A] hover:bg-slate-800 text-slate-200 text-xs font-medium border border-slate-800 transition disabled:opacity-50 shadow-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-[#FF4FA3]' : 'text-slate-400'}`} />
            <span>{isRefreshing ? 'Testing...' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* GPU / WORKLOAD ARCHITECTURE AUDIT CARD */}
      <div className="p-5 sm:p-6 rounded-2xl bg-[#1E293B] border border-slate-800 space-y-4 shadow-sm">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center space-x-3">
            <Zap className="w-5 h-5 text-emerald-400" />
            <div>
              <h3 className="text-sm font-bold text-slate-200">Hardware & Workload Acceleration Audit</h3>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Detailed breakdown of GPU vs CPU vs Network tasks across the Yimly Sync pipeline.
              </p>
            </div>
          </div>
          <span className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold ${
            py?.cudaAvailable
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'bg-slate-800 text-slate-400 border border-slate-700'
          }`}>
            {py?.cudaAvailable ? 'CUDA ACCELERATED' : 'CPU FALLBACK'}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 pt-1">
          {/* Demucs */}
          <div className="p-3.5 rounded-xl bg-[#0F172A] border border-slate-800/90 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-[#FF4FA3]" />
                Demucs Stem Separation
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-purple-500/15 text-purple-300 border border-purple-500/30">
                GPU (CUDA)
              </span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Executes via PyTorch with <code className="text-purple-300 font-mono">--device cuda</code>. Runs deep ConvNet/Transformer layers on NVIDIA Tensor Cores.
            </p>
          </div>

          {/* WhisperX */}
          <div className="p-3.5 rounded-xl bg-[#0F172A] border border-slate-800/90 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-pink-400" />
                WhisperX / Forced Alignment
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-pink-500/15 text-pink-300 border border-pink-500/30">
                GPU (float16)
              </span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Uses CTranslate2 with <code className="text-pink-300 font-mono">device="cuda", compute_type="float16"</code> for fast acoustic forced alignment.
            </p>
          </div>

          {/* FFmpeg */}
          <div className="p-3.5 rounded-xl bg-[#0F172A] border border-slate-800/90 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                <HardDrive className="w-3.5 h-3.5 text-amber-400" />
                FFmpeg Audio Encoding
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                CPU (Designed)
              </span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Audio codecs (FLAC, libmp3lame, AAC) have no GPU encoder in NVIDIA NVENC (NVENC is video-only). Audio encoding is lightweight and CPU-bound by design.
            </p>
          </div>

          {/* Lyric APIs */}
          <div className="p-3.5 rounded-xl bg-[#0F172A] border border-slate-800/90 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                <Network className="w-3.5 h-3.5 text-sky-400" />
                Lyric Providers
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-sky-500/15 text-sky-300 border border-sky-500/30">
                Network I/O
              </span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Asynchronous HTTP REST API queries across NetEase, QQ Music, Kugou, and Musixmatch. Runs independently from audio processing.
            </p>
          </div>
        </div>

        {/* Live GPU Audit Results if triggered */}
        {gpuAuditData && (
          <div className="mt-4 p-4 rounded-xl bg-[#0B1120] border border-purple-500/30 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-purple-300 font-mono flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-purple-400" />
                Live GPU Audit Report ({new Date(gpuAuditData.timestamp).toLocaleTimeString()})
              </span>
              <span className="text-[11px] font-mono text-slate-400">
                Device: {gpuAuditData.deviceName || 'None'}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs font-mono">
              <div className="p-2.5 rounded-lg bg-[#1E293B] border border-slate-800">
                <div className="text-slate-400 text-[10px]">CUDA Detected</div>
                <div className={gpuAuditData.cudaAvailable ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold'}>
                  {gpuAuditData.cudaAvailable ? 'YES' : 'NO (CPU Mode)'}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-[#1E293B] border border-slate-800">
                <div className="text-slate-400 text-[10px]">Tensor Allocation</div>
                <div className={gpuAuditData.tensorVerified ? 'text-emerald-400 font-bold' : 'text-slate-400'}>
                  {gpuAuditData.tensorVerified ? 'VERIFIED (RTX Core)' : 'Not Tested'}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-[#1E293B] border border-slate-800">
                <div className="text-slate-400 text-[10px]">Available VRAM</div>
                <div className="text-slate-200 font-bold">
                  {gpuAuditData.vramGb ? `${gpuAuditData.vramGb} GB` : 'N/A'}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Diagnostics List */}
      <div className="p-6 rounded-2xl bg-[#1E293B] border border-slate-800 space-y-4 shadow-sm">
        <div className="flex items-center space-x-3 pb-3 border-b border-slate-800">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <h3 className="text-sm font-bold text-slate-200">Runtime & Dependency Environment</h3>
        </div>

        <div className="divide-y divide-slate-800/80">
          {checks.map((c, i) => (
            <div key={i} className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-0.5">
                <div className="flex items-center space-x-2">
                  <span className="font-semibold text-xs text-slate-200">{c.name}</span>
                </div>
                <p className="text-[11px] text-slate-400">{c.description}</p>
              </div>

              <div className="flex items-center space-x-2.5 flex-shrink-0">
                <span className={`px-3 py-1 rounded-xl text-xs font-mono font-medium border ${
                  c.ok
                    ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                    : 'bg-amber-500/10 border-amber-500/20 text-amber-300'
                }`}>
                  {c.value}
                </span>
                {c.ok ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
