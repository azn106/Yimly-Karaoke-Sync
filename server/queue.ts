import { SyncJob, JobStatus, ProcessingPhase, EngineLog, SystemStatus, SubTaskStatus } from '../src/types.js';
import { JobExecutor } from './executor.js';
import { checkSongCompletion } from './scanner.js';
import path from 'path';
import { EventEmitter } from 'events';

class AsyncSemaphore {
  private current = 0;
  private queue: (() => void)[] = [];

  constructor(public readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.current < this.max) {
      this.current++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          this.release();
        }
      };
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        this.current++;
        let released = false;
        resolve(() => {
          if (!released) {
            released = true;
            this.release();
          }
        });
      });
    });
  }

  private release() {
    this.current--;
    if (this.queue.length > 0 && this.current < this.max) {
      const next = this.queue.shift();
      if (next) next();
    }
  }

  get activeCount(): number {
    return this.current;
  }
}

export class QueueManager extends EventEmitter {
  private queue: SyncJob[] = [];
  private isPaused = false;
  private isMonitoring = false;
  private activeExecutors = new Map<string, JobExecutor>();
  private logs: EngineLog[] = [];
  private maxLogs = 1000;

  // Safe concurrency boundaries
  private readonly maxConcurrentSongs = 2;
  private readonly audioSemaphore = new AsyncSemaphore(1);   // 1 heavy Demucs/GPU job at a time
  private readonly lyricsSemaphore = new AsyncSemaphore(4);  // up to 4 concurrent network queries
  private activeSongCount = 0;

  constructor() {
    super();
  }

  getJobs(): SyncJob[] {
    return [...this.queue];
  }

  getLogs(): EngineLog[] {
    return [...this.logs];
  }

  isQueuePaused(): boolean {
    return this.isPaused;
  }

  isMonitorRunning(): boolean {
    return this.isMonitoring;
  }

  setMonitoring(running: boolean) {
    this.isMonitoring = running;
    this.emit('status_changed', this.getSystemSummary());
  }

  setQueuePaused(paused: boolean) {
    this.isPaused = paused;
    this.addLog('INFO', `Queue ${paused ? 'PAUSED' : 'RESUMED'}`);
    this.emit('status_changed', this.getSystemSummary());
    if (!paused) {
      this.notifyWorker();
    }
  }

  addLog(level: EngineLog['level'], message: string, jobId?: string) {
    const logItem: EngineLog = {
      id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      timestamp: Date.now(),
      level,
      message,
      jobId,
    };
    this.logs.push(logItem);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    this.emit('log', logItem);
  }

  notifyWorker() {
    if (this.isPaused) {
      return;
    }
    this.dispatchWorkerQueue();
  }

  enqueueSong(filePath: string, artistName: string, initialStatus: JobStatus = 'QUEUED', force = false): SyncJob | null {
    const absPath = path.resolve(filePath);
    const fileName = path.basename(absPath);
    const ext = path.extname(absPath);
    const basename = path.basename(absPath, ext);

    const existing = this.queue.find(j => j.id === absPath);

    // If already in queue, handle state transitions
    if (existing && !force) {
      if (existing.status === 'PROCESSING' || existing.status === 'QUEUED') {
        return null;
      }
      if (existing.status === 'COMPLETE') {
        return null;
      }
      if (existing.status === 'WAITING_FOR_FILE') {
        if (initialStatus === 'QUEUED') {
          existing.status = 'QUEUED';
          existing.progress = 0;
          existing.currentPhase = 'Detecting';
          existing.phaseMessage = 'Queued for processing';
          this.addLog('INFO', `Queued song for processing: "${existing.fileName}" (${existing.artistName})`, existing.id);
          this.emit('job_updated', existing);
          this.emit('status_changed', this.getSystemSummary());
          this.notifyWorker();
          return existing;
        }
        return existing;
      }
      if (existing.status === 'FAILED' && initialStatus === 'QUEUED') {
        existing.status = 'QUEUED';
        existing.progress = 0;
        existing.error = undefined;
        existing.currentPhase = 'Detecting';
        existing.phaseMessage = 'Queued for processing';
        existing.audioTask = undefined;
        existing.lyricsTask = undefined;
        this.addLog('INFO', `Queued song for processing: "${existing.fileName}" (${existing.artistName})`, existing.id);
        this.emit('job_updated', existing);
        this.emit('status_changed', this.getSystemSummary());
        this.notifyWorker();
        return existing;
      }
    }

    // Check completion status
    const completion = checkSongCompletion(absPath);
    if (completion.isComplete && !force) {
      this.addLog('INFO', `Song already complete: "${fileName}" (Outputs verified). Skipping.`);
      return null;
    }

    const job: SyncJob = {
      id: absPath,
      filePath: absPath,
      fileName,
      artistName: artistName || path.basename(path.dirname(absPath)),
      songTitle: basename,
      status: initialStatus,
      progress: 0,
      currentPhase: 'Detecting',
      phaseMessage: initialStatus === 'WAITING_FOR_FILE' ? 'Waiting for copy to complete...' : 'Queued for processing',
      audioTask: { status: 'QUEUED', progress: 0, message: 'Queued for Demucs stem separation' },
      lyricsTask: { status: 'QUEUED', progress: 0, message: 'Queued for dual lyrics retrieval' },
      addedAt: Date.now(),
      liveSegments: [],
      liveWords: [],
      logs: [],
    };

    if (existing) {
      const index = this.queue.findIndex(j => j.id === absPath);
      this.queue[index] = job;
    } else {
      this.queue.push(job);
    }

    if (initialStatus === 'QUEUED') {
      this.addLog('INFO', `Queued song for processing: "${job.fileName}" (${job.artistName})`, job.id);
    }

    this.emit('job_updated', job);
    this.emit('status_changed', this.getSystemSummary());

    if (initialStatus === 'QUEUED') {
      this.notifyWorker();
    }

    return job;
  }

  private throttledJobTimers = new Map<string, NodeJS.Timeout>();

  private emitJobUpdated(job: SyncJob, immediate = false) {
    if (immediate) {
      const existing = this.throttledJobTimers.get(job.id);
      if (existing) {
        clearTimeout(existing);
        this.throttledJobTimers.delete(job.id);
      }
      this.emit('job_updated', job);
      return;
    }

    if (this.throttledJobTimers.has(job.id)) {
      return;
    }

    const timer = setTimeout(() => {
      this.throttledJobTimers.delete(job.id);
      const current = this.queue.find(x => x.id === job.id);
      if (current) {
        this.emit('job_updated', current);
      }
    }, 100);

    this.throttledJobTimers.set(job.id, timer);
  }

  updateJobStatus(jobId: string, status: JobStatus, phase?: ProcessingPhase, progress?: number, message?: string) {
    const job = this.queue.find(j => j.id === jobId);
    if (!job) return;

    job.status = status;
    if (phase) job.currentPhase = phase;
    if (progress !== undefined) job.progress = progress;
    if (message) job.phaseMessage = message;

    if (status === 'PROCESSING' && !job.startedAt) {
      job.startedAt = Date.now();
    }
    if (status === 'COMPLETE' || status === 'FAILED') {
      job.completedAt = Date.now();
    }

    this.emitJobUpdated(job, true);
    this.emit('status_changed', this.getSystemSummary());

    if (status === 'QUEUED') {
      this.notifyWorker();
    }
  }

  retryFailed() {
    this.addLog('INFO', 'Retrying all failed jobs...');
    let count = 0;
    for (const job of this.queue) {
      if (job.status === 'FAILED') {
        job.status = 'QUEUED';
        job.progress = 0;
        job.error = undefined;
        job.currentPhase = 'Detecting';
        job.phaseMessage = 'Retrying job';
        job.audioTask = undefined;
        job.lyricsTask = undefined;
        this.emit('job_updated', job);
        count++;
      }
    }
    this.emit('status_changed', this.getSystemSummary());
    if (count > 0) {
      this.notifyWorker();
    }
  }

  retryJob(jobId: string) {
    const job = this.queue.find(j => j.id === jobId);
    if (!job) return;

    job.status = 'QUEUED';
    job.progress = 0;
    job.error = undefined;
    job.currentPhase = 'Detecting';
    job.phaseMessage = 'Retrying job';
    job.audioTask = undefined;
    job.lyricsTask = undefined;
    this.addLog('INFO', `Retrying job: ${job.fileName}`, job.id);
    this.emit('job_updated', job);
    this.emit('status_changed', this.getSystemSummary());
    this.notifyWorker();
  }

  clearCompleted() {
    const beforeCount = this.queue.length;
    this.queue = this.queue.filter(j => j.status !== 'COMPLETE' && j.status !== 'SKIPPED');
    const removed = beforeCount - this.queue.length;
    this.addLog('INFO', `Cleared ${removed} completed/skipped jobs from queue.`);
    this.emit('queue_cleared');
    this.emit('status_changed', this.getSystemSummary());
  }

  removeJob(jobId: string) {
    const index = this.queue.findIndex(j => j.id === jobId);
    if (index !== -1) {
      const job = this.queue[index];
      const activeExec = this.activeExecutors.get(jobId);
      if (activeExec) {
        activeExec.abort();
        this.activeExecutors.delete(jobId);
      }
      this.queue.splice(index, 1);
      this.addLog('INFO', `Removed job: ${job.fileName}`);
      this.emit('job_removed', jobId);
      this.emit('status_changed', this.getSystemSummary());
      this.notifyWorker();
    }
  }

  getActiveJob(): SyncJob | null {
    return this.queue.find(j => j.status === 'PROCESSING') || null;
  }

  getActiveJobs(): SyncJob[] {
    return this.queue.filter(j => j.status === 'PROCESSING');
  }

  private isDispatching = false;

  private dispatchWorkerQueue() {
    if (this.isPaused || this.isDispatching) return;
    this.isDispatching = true;

    try {
      while (!this.isPaused && this.activeSongCount < this.maxConcurrentSongs) {
        const nextJob = this.queue.find(j => j.status === 'QUEUED');
        if (!nextJob) break;

        this.activeSongCount++;
        this.runConcurrentJob(nextJob);
      }
    } finally {
      this.isDispatching = false;
      this.emit('status_changed', this.getSystemSummary());
    }
  }

  private async runConcurrentJob(job: SyncJob) {
    const executor = new JobExecutor();
    this.activeExecutors.set(job.id, executor);

    this.updateJobStatus(job.id, 'PROCESSING', 'Detecting', 5, 'Starting processing job...');

    try {
      await executor.executeJob(
        job,
        {
          onProgress: (jobId, phase, progress, msg) => {
            const j = this.queue.find(x => x.id === jobId);
            if (j) {
              j.currentPhase = phase;
              j.progress = progress;
              j.phaseMessage = msg;
              this.emitJobUpdated(j, false);
            }
          },
          onSubTaskProgress: (jobId, task, progress, msg, status) => {
            const j = this.queue.find(x => x.id === jobId);
            if (j) {
              if (task === 'audio' && j.audioTask) {
                j.audioTask.progress = progress;
                j.audioTask.message = msg;
                if (status) j.audioTask.status = status;
              } else if (task === 'lyrics' && j.lyricsTask) {
                j.lyricsTask.progress = progress;
                j.lyricsTask.message = msg;
                if (status) j.lyricsTask.status = status;
              }
              this.emitJobUpdated(j, false);
            }
          },
          onLog: (logItem) => {
            this.logs.push(logItem);
            if (this.logs.length > this.maxLogs) this.logs.shift();
            const j = this.queue.find(x => x.id === logItem.jobId);
            if (j) {
              j.logs = j.logs || [];
              j.logs.push(logItem.message);
            }
            this.emit('log', logItem);
          },
          onSegment: (jobId, seg) => {
            const j = this.queue.find(x => x.id === jobId);
            if (j) {
              j.liveSegments = j.liveSegments || [];
              j.liveSegments.push(seg);
              this.emitJobUpdated(j, false);
            }
          },
          onWord: (jobId, word) => {
            const j = this.queue.find(x => x.id === jobId);
            if (j) {
              j.liveWords = j.liveWords || [];
              j.liveWords.push(word);
              this.emitJobUpdated(j, false);
            }
          },
          onComplete: (jobId) => {
            const j = this.queue.find(x => x.id === jobId);
            if (j) {
              j.status = 'COMPLETE';
              j.progress = 100;
              j.currentPhase = 'Complete';
              j.phaseMessage = 'Complete ✓';
              j.completedAt = Date.now();
              this.emitJobUpdated(j, true);
            }
          },
          onFailed: (jobId, err) => {
            const j = this.queue.find(x => x.id === jobId);
            if (j) {
              j.status = 'FAILED';
              j.currentPhase = 'Failed';
              j.error = err;
              j.phaseMessage = `Failed: ${err}`;
              j.completedAt = Date.now();
              this.emitJobUpdated(j, true);
            }
          }
        },
        {
          acquireAudioSlot: () => this.audioSemaphore.acquire(),
          acquireLyricsSlot: () => this.lyricsSemaphore.acquire(),
        }
      );
    } catch (err: any) {
      this.updateJobStatus(job.id, 'FAILED', 'Failed', undefined, err.message);
    } finally {
      this.activeExecutors.delete(job.id);
      this.activeSongCount = Math.max(0, this.activeSongCount - 1);
      this.emit('status_changed', this.getSystemSummary());
      // Prompt worker to check if more songs are waiting
      this.dispatchWorkerQueue();
    }
  }

  getSystemSummary(): SystemStatus & { totalInQueue: number } {
    const activeJobs = this.getActiveJobs();
    const queuedJobs = this.queue.filter(j => j.status === 'QUEUED').length;
    const failedJobs = this.queue.filter(j => j.status === 'FAILED').length;
    const completedJobs = this.queue.filter(j => j.status === 'COMPLETE').length;

    return {
      monitoring: this.isMonitoring,
      queuePaused: this.isPaused,
      activeJobId: activeJobs.length > 0 ? activeJobs[0].id : null,
      activeJobIds: activeJobs.map(j => j.id),
      totalSongs: this.queue.length,
      completedSongs: completedJobs,
      incompleteSongs: queuedJobs + failedJobs + activeJobs.length,
      queuedJobs,
      failedJobs,
      totalInQueue: this.queue.length,
      concurrency: {
        maxConcurrentSongs: this.maxConcurrentSongs,
        maxConcurrentAudio: this.audioSemaphore.max,
        maxConcurrentLyrics: this.lyricsSemaphore.max,
        activeAudio: this.audioSemaphore.activeCount,
        activeLyrics: this.lyricsSemaphore.activeCount,
      },
    };
  }
}

export const globalQueue = new QueueManager();
