import React, { useState } from 'react';
import { 
  Play, 
  RotateCcw, 
  Trash2, 
  CheckCircle2, 
  AlertCircle, 
  Clock, 
  FileAudio, 
  Layers, 
  Sparkles, 
  PlusCircle, 
  ChevronRight, 
  FolderOpen, 
  Radio,
  FileText,
  Music,
  Mic,
  ArrowRight,
  Filter,
  CheckCircle,
  XCircle,
  Activity,
  Zap,
  Network
} from 'lucide-react';
import { SyncJob, JobStatus, ProcessingPhase, SubTaskStatus } from '../types.js';

interface QueueViewProps {
  jobs: SyncJob[];
  activeJob: SyncJob | null;
  onRetryFailed: () => void;
  onRetryJob: (id: string) => void;
  onClearCompleted: () => void;
  onRemoveJob: (id: string) => void;
  onProcessAllIncomplete: () => void;
  onAddSampleSong: () => void;
  onSelectJobLogs?: (jobId: string) => void;
  userRole?: 'ADMIN' | 'USER';
}

export const QueueView: React.FC<QueueViewProps> = ({
  jobs,
  activeJob,
  onRetryFailed,
  onRetryJob,
  onClearCompleted,
  onRemoveJob,
  onProcessAllIncomplete,
  onAddSampleSong,
  onSelectJobLogs,
  userRole,
}) => {
  const isAdmin = userRole === 'ADMIN';
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const activeJobs = jobs.filter(j => j.status === 'PROCESSING');
  const failedCount = jobs.filter(j => j.status === 'FAILED').length;
  const completedCount = jobs.filter(j => j.status === 'COMPLETE').length;
  const queuedCount = jobs.filter(j => j.status === 'QUEUED' || j.status === 'WAITING_FOR_FILE').length;

  const filteredJobs = jobs.filter(job => {
    if (filterStatus !== 'ALL' && job.status !== filterStatus) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        job.fileName.toLowerCase().includes(q) ||
        job.artistName.toLowerCase().includes(q) ||
        job.songTitle.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const getSubTaskBadge = (status?: SubTaskStatus, device?: string) => {
    switch (status) {
      case 'COMPLETE':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
            <CheckCircle2 className="w-2.5 h-2.5" />
            COMPLETE {device ? `(${device.toUpperCase()})` : ''}
          </span>
        );
      case 'PROCESSING':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#FF4FA3]/15 text-[#FF4FA3] border border-[#FF4FA3]/30 animate-pulse">
            <Radio className="w-2.5 h-2.5" />
            PROCESSING {device ? `(${device.toUpperCase()})` : ''}
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-red-500/15 text-red-400 border border-red-500/25">
            <AlertCircle className="w-2.5 h-2.5" />
            FAILED
          </span>
        );
      case 'SKIPPED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-slate-800 text-slate-400 border border-slate-700">
            SKIPPED
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-slate-800 text-slate-400 border border-slate-700">
            <Clock className="w-2.5 h-2.5" />
            QUEUED
          </span>
        );
    }
  };

  const getStatusBadge = (status: JobStatus) => {
    switch (status) {
      case 'PROCESSING':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#FF4FA3]/15 text-[#FF4FA3] border border-[#FF4FA3]/30 animate-pulse">
            <Radio className="w-3 h-3 text-[#FF4FA3]" />
            PROCESSING
          </span>
        );
      case 'COMPLETE':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
            COMPLETE ✓
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/20">
            <AlertCircle className="w-3 h-3 text-red-400" />
            FAILED
          </span>
        );
      case 'WAITING_FOR_FILE':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-500/10 text-amber-300 border border-amber-500/20">
            <Clock className="w-3 h-3 text-amber-400" />
            WAITING FILE
          </span>
        );
      case 'SKIPPED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-800 text-slate-400 border border-slate-700">
            SKIPPED
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-800/90 text-slate-300 border border-slate-700">
            <Clock className="w-3 h-3 text-slate-400" />
            QUEUED
          </span>
        );
    }
  };

  return (
    <div className="space-y-8">
      {/* Top Metric Cards Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {/* Metric 1: Processing */}
        <div className="bg-[#1E293B] p-5 rounded-2xl border border-slate-800 shadow-sm flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
              Active Pipelines
            </div>
            <div className="text-2xl font-bold text-slate-100 font-mono">
              {activeJobs.length}
            </div>
            <div className="text-[11px] text-[#FF4FA3] mt-1 truncate max-w-[150px]">
              {activeJobs.length > 0 ? `${activeJobs.length} song(s) concurrent` : 'Engine idle'}
            </div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-[#FF4FA3]/10 border border-[#FF4FA3]/20 flex items-center justify-center text-[#FF4FA3]">
            <Zap className="w-5 h-5" />
          </div>
        </div>

        {/* Metric 2: Queued */}
        <div className="bg-[#1E293B] p-5 rounded-2xl border border-slate-800 shadow-sm flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
              Pending in Queue
            </div>
            <div className="text-2xl font-bold text-slate-100 font-mono">
              {queuedCount}
            </div>
            <div className="text-[11px] text-amber-400 mt-1">
              {queuedCount > 0 ? 'Awaiting worker' : 'All caught up'}
            </div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
            <Clock className="w-5 h-5" />
          </div>
        </div>

        {/* Metric 3: Complete */}
        <div className="bg-[#1E293B] p-5 rounded-2xl border border-slate-800 shadow-sm flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
              Completed Syncs
            </div>
            <div className="text-2xl font-bold text-emerald-400 font-mono">
              {completedCount}
            </div>
            <div className="text-[11px] text-emerald-400/80 mt-1">
              Outputs verified on disk
            </div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
            <CheckCircle2 className="w-5 h-5" />
          </div>
        </div>

        {/* Metric 4: Failed */}
        <div className="bg-[#1E293B] p-5 rounded-2xl border border-slate-800 shadow-sm flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
              Failed Jobs
            </div>
            <div className={`text-2xl font-bold font-mono ${failedCount > 0 ? 'text-red-400' : 'text-slate-100'}`}>
              {failedCount}
            </div>
            <div className="text-[11px] text-red-400/80 mt-1">
              {failedCount > 0 ? 'Retry available' : 'No errors logged'}
            </div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400">
            <XCircle className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Action Toolbar & Concurrency Info */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 sm:p-4 rounded-2xl bg-[#1E293B] border border-slate-800 shadow-sm">
        <div className="grid grid-cols-1 xs:grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 sm:gap-2.5 w-full sm:w-auto">
          <button
            onClick={onProcessAllIncomplete}
            className="flex items-center justify-center space-x-2 px-4 py-2.5 sm:py-2 rounded-xl bg-[#FF4FA3] hover:bg-[#ff3d99] text-white text-xs font-semibold shadow-md shadow-[#FF4FA3]/20 transition active:scale-95 min-h-[40px] sm:min-h-0"
          >
            <Play className="w-3.5 h-3.5" />
            <span>Process Incomplete</span>
          </button>

          <button
            onClick={onRetryFailed}
            disabled={failedCount === 0 || !isAdmin}
            className="flex items-center justify-center space-x-2 px-3.5 py-2.5 sm:py-2 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition disabled:opacity-40 min-h-[40px] sm:min-h-0"
            title={!isAdmin ? 'Administrator privileges required' : 'Retry failed jobs'}
          >
            <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
            <span>Retry Failed ({failedCount})</span>
          </button>

          <button
            onClick={onClearCompleted}
            disabled={completedCount === 0 || !isAdmin}
            className="flex items-center justify-center space-x-2 px-3.5 py-2.5 sm:py-2 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 transition disabled:opacity-40 min-h-[40px] sm:min-h-0 xs:col-span-2 sm:col-span-1"
            title={!isAdmin ? 'Administrator privileges required' : 'Clear completed jobs from list'}
          >
            <Trash2 className="w-3.5 h-3.5 text-slate-400" />
            <span>Clear Completed ({completedCount})</span>
          </button>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="hidden md:flex items-center gap-2 text-[11px] font-mono text-slate-400 px-3 py-1.5 bg-[#0F172A] rounded-xl border border-slate-800">
            <span className="text-emerald-400">⚡ Concurrent Architecture:</span>
            <span>Audio: 1 (Demucs/GPU)</span>
            <span className="text-slate-600">|</span>
            <span>Lyrics: 4 (Async Net)</span>
          </div>

          <button
            onClick={onAddSampleSong}
            disabled={!isAdmin}
            className="w-full sm:w-auto flex items-center justify-center space-x-2 px-3.5 py-2.5 sm:py-2 rounded-xl bg-[#0F172A] hover:bg-slate-800 text-slate-300 text-xs font-medium border border-slate-800 transition min-h-[40px] sm:min-h-0 disabled:opacity-40"
            title={!isAdmin ? 'Administrator privileges required' : 'Simulates copying a new audio file into /media'}
          >
            <PlusCircle className="w-3.5 h-3.5 text-[#FF4FA3]" />
            <span>Simulate New File</span>
          </button>
        </div>
      </div>

      {/* ACTIVE PROCESSING HERO CARDS (SUPPORTS CONCURRENT PIPELINES) */}
      {activeJobs.length > 0 ? (
        <div className="space-y-4">
          {activeJobs.map(job => (
            <div key={job.id} className="p-5 sm:p-6 rounded-2xl bg-[#1E293B] border border-[#FF4FA3]/35 shadow-xl shadow-[#FF4FA3]/5 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="flex items-start space-x-4">
                  <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-[#FF4FA3]/15 border border-[#FF4FA3]/30 text-[#FF4FA3] shadow-inner flex-shrink-0">
                    <Music className="w-6 h-6 animate-pulse" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center space-x-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-[#FF4FA3]">
                        Active Concurrent Processing
                      </span>
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-[#0F172A] text-pink-300 border border-slate-800">
                        {job.fileName.split('.').pop()?.toUpperCase()}
                      </span>
                    </div>
                    <h3 className="text-lg font-bold text-slate-100 tracking-tight mt-0.5 truncate">
                      {job.artistName} — {job.songTitle}
                    </h3>
                    <p className="text-xs text-slate-400 font-mono truncate max-w-xl mt-0.5">
                      {job.filePath}
                    </p>
                  </div>
                </div>

                <div className="sm:text-right">
                  <div className="text-3xl font-black font-mono text-[#FF4FA3]">
                    {job.progress}%
                  </div>
                  <div className="text-xs font-semibold text-slate-300 mt-0.5">
                    {job.currentPhase}
                  </div>
                </div>
              </div>

              {/* INDEPENDENT CONCURRENT SUBTASK CARDS */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Audio/Instrumental Task */}
                <div className="p-4 rounded-xl bg-[#0F172A] border border-slate-800/90 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <Layers className="w-4 h-4 text-[#FF4FA3]" />
                      <span className="text-xs font-bold text-slate-200">1. Instrumental / Audio Task</span>
                    </div>
                    {getSubTaskBadge(job.audioTask?.status, job.audioTask?.device)}
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-[11px] font-mono text-slate-400">
                      <span className="truncate max-w-[200px]">{job.audioTask?.message || 'Queued for Demucs stem separation'}</span>
                      <span className="text-[#FF4FA3] font-bold">{job.audioTask?.progress ?? 0}%</span>
                    </div>
                    <div className="h-2 w-full bg-[#1E293B] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-purple-500 to-[#FF4FA3] rounded-full transition-all duration-300"
                        style={{ width: `${Math.max(3, job.audioTask?.progress ?? 0)}%` }}
                      />
                    </div>
                  </div>
                </div>

                {/* Lyrics Task */}
                <div className="p-4 rounded-xl bg-[#0F172A] border border-slate-800/90 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <Network className="w-4 h-4 text-sky-400" />
                      <span className="text-xs font-bold text-slate-200">2. Lyrics Retrieval Task</span>
                    </div>
                    {getSubTaskBadge(job.lyricsTask?.status, job.lyricsTask?.device)}
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-[11px] font-mono text-slate-400">
                      <span className="truncate max-w-[200px]">{job.lyricsTask?.message || 'Dual retrieval (.elrc.lrc + .lrc)'}</span>
                      <span className="text-sky-400 font-bold">{job.lyricsTask?.progress ?? 0}%</span>
                    </div>
                    <div className="h-2 w-full bg-[#1E293B] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-sky-500 to-emerald-400 rounded-full transition-all duration-300"
                        style={{ width: `${Math.max(3, job.lyricsTask?.progress ?? 0)}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Overall Progress Bar */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-slate-300 font-mono">
                  <span>Pipeline Composite Status: <strong className="text-[#FF4FA3]">{job.currentPhase}</strong></span>
                  <span className="text-slate-400">{job.phaseMessage || 'Independent concurrent processing in progress...'}</span>
                </div>
                <div className="h-2.5 w-full bg-[#0F172A] rounded-full overflow-hidden p-0.5 border border-slate-800">
                  <div
                    className="h-full bg-gradient-to-r from-[#FF4FA3] via-pink-500 to-[#FF4FA3] rounded-full transition-all duration-300 shadow-sm"
                    style={{ width: `${Math.max(4, job.progress)}%` }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="p-6 rounded-2xl bg-[#1E293B] border border-slate-800 text-center py-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[#0F172A] text-slate-400 border border-slate-800 mb-3">
            <Activity className="w-6 h-6 text-slate-400" />
          </div>
          <h4 className="text-sm font-semibold text-slate-200">No active jobs running</h4>
          <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
            Monitoring is watching <code className="text-[#FF4FA3] font-mono">/media</code>. Queued songs process audio and lyrics concurrently without blocking.
          </p>
        </div>
      )}

      {/* QUEUE TABLE & SEARCH */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="flex items-center space-x-2">
            <h3 className="text-sm font-bold text-slate-200 tracking-wide flex items-center gap-2">
              <Layers className="w-4 h-4 text-[#FF4FA3]" />
              Queue & Job History ({jobs.length})
            </h3>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 sm:space-x-3 w-full sm:w-auto">
            {/* Filter Buttons */}
            <div className="flex items-center bg-[#1E293B] border border-slate-800 rounded-xl p-1 text-xs overflow-x-auto no-scrollbar">
              {['ALL', 'QUEUED', 'PROCESSING', 'COMPLETE', 'FAILED'].map(st => (
                <button
                  key={st}
                  onClick={() => setFilterStatus(st)}
                  className={`px-3 py-1 rounded-lg font-medium transition whitespace-nowrap min-h-[32px] sm:min-h-0 ${
                    filterStatus === st
                      ? 'bg-[#FF4FA3]/20 text-[#FF4FA3] border border-[#FF4FA3]/30 font-semibold'
                      : 'text-slate-400 hover:text-slate-200 border border-transparent'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>

            {/* Search */}
            <input
              type="text"
              placeholder="Search jobs..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full sm:w-40 px-3.5 py-2 sm:py-1.5 bg-[#1E293B] border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-[#FF4FA3]"
            />
          </div>
        </div>

        {/* Jobs List */}
        {filteredJobs.length === 0 ? (
          <div className="p-10 rounded-2xl bg-[#1E293B]/60 border border-slate-800 text-center text-xs text-slate-500">
            No jobs match the current filter or queue is empty.
          </div>
        ) : (
          <div className="border border-slate-800 rounded-2xl overflow-hidden bg-[#1E293B] shadow-xl">
            <div className="divide-y divide-slate-800/80">
              {filteredJobs.map(job => {
                const isRunning = job.status === 'PROCESSING';

                return (
                  <div
                    key={job.id}
                    className={`p-3.5 sm:p-5 transition flex flex-col md:flex-row md:items-center justify-between gap-3 sm:gap-4 ${
                      isRunning ? 'bg-[#FF4FA3]/10' : 'hover:bg-slate-800/40'
                    }`}
                  >
                    {/* Song Details */}
                    <div className="flex items-start space-x-3 sm:space-x-3.5 min-w-0">
                      <div className="flex-shrink-0 mt-0.5">
                        <FileAudio className={`w-5 h-5 ${
                          job.status === 'COMPLETE' ? 'text-emerald-400' :
                          job.status === 'FAILED' ? 'text-red-400' :
                          job.status === 'PROCESSING' ? 'text-[#FF4FA3] animate-pulse' : 'text-slate-400'
                        }`} />
                      </div>
                      <div className="min-w-0 space-y-1 flex-1">
                        <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                          <span className="font-semibold text-slate-100 text-xs sm:text-sm truncate max-w-[200px] xs:max-w-xs sm:max-w-md">
                            {job.artistName} — {job.songTitle}
                          </span>
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-[#0F172A] text-slate-300 border border-slate-800">
                            {job.fileName.split('.').pop()?.toUpperCase()}
                          </span>
                          {job.executionDevice && (
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold ${
                              job.executionDevice === 'cuda'
                                ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                                : 'bg-slate-800 text-slate-400'
                            }`}>
                              {job.executionDevice.toUpperCase()}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] sm:text-xs text-slate-400 font-mono truncate max-w-full sm:max-w-md">
                          {job.filePath}
                        </p>

                        {/* Dual subtask badges in queue list */}
                        <div className="flex items-center gap-2 pt-0.5 text-[10px] font-mono text-slate-400">
                          <span className="flex items-center gap-1">
                            Audio: <strong className={job.instrumentalStatus === 'GENERATED' || job.instrumentalStatus === 'EXISTS' ? 'text-emerald-400' : 'text-slate-400'}>
                              {job.instrumentalStatus || 'PENDING'}
                            </strong>
                          </span>
                          <span>•</span>
                          <span className="flex items-center gap-1">
                            eLRC: <strong className={job.elrcStatus === 'FETCHED' || job.elrcStatus === 'EXISTS' ? 'text-emerald-400' : (job.elrcStatus === 'NOT_FOUND' ? 'text-amber-400' : 'text-slate-400')}>
                              {job.elrcStatus || 'PENDING'}
                            </strong>
                          </span>
                          <span>•</span>
                          <span className="flex items-center gap-1">
                            LRC: <strong className={job.lrcStatus === 'FETCHED' || job.lrcStatus === 'EXISTS' ? 'text-emerald-400' : (job.lrcStatus === 'NOT_FOUND' ? 'text-amber-400' : 'text-slate-400')}>
                              {job.lrcStatus || 'PENDING'}
                            </strong>
                          </span>
                        </div>

                        {job.error && (
                          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 p-2 rounded-lg mt-1.5 font-mono break-all">
                            Error: {job.error}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Status & Progress & Controls */}
                    <div className="flex items-center justify-between md:justify-end space-x-3 sm:space-x-4 flex-shrink-0 pt-2 md:pt-0 border-t md:border-t-0 border-slate-800/60">
                      {/* Phase / Status */}
                      <div className="text-left md:text-right space-y-0.5 min-w-[110px] sm:min-w-[130px]">
                        <div>{getStatusBadge(job.status)}</div>
                        <div className="text-[10px] sm:text-[11px] text-slate-400 truncate max-w-[120px] sm:max-w-[150px]">
                          {job.currentPhase || job.status}
                        </div>
                      </div>

                      {/* Progress bar */}
                      <div className="w-20 sm:w-24 space-y-1 flex-shrink-0">
                        <div className="flex justify-between text-[10px] font-mono text-slate-400">
                          <span>{job.progress}%</span>
                        </div>
                        <div className="h-1.5 w-full bg-[#0F172A] rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              job.status === 'COMPLETE' ? 'bg-emerald-500' :
                              job.status === 'FAILED' ? 'bg-red-500' : 'bg-[#FF4FA3]'
                            }`}
                            style={{ width: `${job.progress}%` }}
                          />
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="flex items-center space-x-1 flex-shrink-0">
                        {job.status === 'FAILED' && (
                          <button
                            onClick={() => onRetryJob(job.id)}
                            className="p-2 sm:p-2 rounded-lg hover:bg-slate-800 text-amber-400 hover:text-amber-300 transition border border-transparent hover:border-slate-700 min-w-[36px] min-h-[36px] flex items-center justify-center"
                            title="Retry this job"
                          >
                            <RotateCcw className="w-4 h-4" />
                          </button>
                        )}
                        {job.status !== 'PROCESSING' && (
                          <button
                            onClick={() => onRemoveJob(job.id)}
                            className="p-2 sm:p-2 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-red-400 transition border border-transparent hover:border-slate-700 min-w-[36px] min-h-[36px] flex items-center justify-center"
                            title="Remove from queue"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
