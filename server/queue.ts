import { SyncJob, JobStatus, ProcessingPhase, EngineLog, SystemStatus, SubTaskStatus } from '../src/types.js';
import { JobExecutor } from './executor.js';
import { checkSongCompletion } from './scanner.js';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';

const QUEUE_STATE_FILE = path.join(process.cwd(), 'yimly_queue_state.json');

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
  private persistTimer: NodeJS.Timeout | null = null;
  public stateFilePath = QUEUE_STATE_FILE;

  // Safe concurrency boundaries
  private readonly maxConcurrentSongs = 2;
  private readonly audioSemaphore = new AsyncSemaphore(1);   // 1 heavy Demucs/GPU job at a time
  private readonly lyricsSemaphore = new AsyncSemaphore(4);  // up to 4 concurrent network queries
  private activeSongCount = 0;

  constructor(stateFilePath?: string) {
    super();
    if (stateFilePath) {
      this.stateFilePath = stateFilePath;
    }
    this.loadPersistedQueue();
  }

  public loadPersistedQueue() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const loadedJobs: SyncJob[] = [];
          for (const item of parsed) {
            if (!item || !item.filePath) continue;
            const absPath = path.resolve(item.filePath);
            const sourceExists = fs.existsSync(absPath);
            const completion = checkSongCompletion(absPath);

            let status: JobStatus = item.status || 'QUEUED';
            let phase: ProcessingPhase = item.currentPhase || 'Detecting';
            let progress = item.progress || 0;
            let phaseMessage = item.phaseMessage || '';
            let error = item.error;

            if (!sourceExists) {
              status = 'FAILED';
              phase = 'Failed';
              error = 'Source audio file no longer exists on disk';
              phaseMessage = 'Source file missing';
            } else if (completion.isComplete) {
              status = 'COMPLETE';
              phase = 'Complete';
              progress = 100;
              phaseMessage = 'Complete ✓ (Verified outputs)';
              error = undefined;
            } else if (status === 'PROCESSING') {
              // Interrupted during previous run: safely re-queue for recovery
              status = 'QUEUED';
              phase = 'Detecting';
              progress = 0;
              phaseMessage = 'Resumed after server restart';
              error = undefined;
            }

            const job: SyncJob = {
              ...item,
              id: absPath,
              filePath: absPath,
              status,
              currentPhase: phase,
              progress,
              phaseMessage,
              error,
              audioTask: status === 'COMPLETE' ? { status: 'COMPLETE', progress: 100 } : undefined,
              lyricsTask: status === 'COMPLETE' ? { status: 'COMPLETE', progress: 100 } : undefined,
              liveSegments: [],
              liveWords: [],
              logs: item.logs || [],
              retryCount: item.retryCount || 0,
            };

            // Deduplicate
            if (!loadedJobs.some(j => j.id === absPath)) {
              loadedJobs.push(job);
            }
          }
          this.queue = loadedJobs;
        }
      }
    } catch (e: any) {
      this.addLog('WARN', `Failed to load persisted queue state: ${e.message}`);
    }
  }

  public savePersistedQueue(immediate = false) {
    const doSave = () => {
      try {
        const cleanJobs = this.queue.map(j => ({
          id: j.id,
          filePath: j.filePath,
          fileName: j.fileName,
          artistName: j.artistName,
          songTitle: j.songTitle,
          status: j.status,
          progress: j.progress,
          currentPhase: j.currentPhase,
          phaseMessage: j.phaseMessage,
          error: j.error,
          addedAt: j.addedAt,
          startedAt: j.startedAt,
          completedAt: j.completedAt,
          instrumentalStatus: j.instrumentalStatus,
          elrcStatus: j.elrcStatus,
          lrcStatus: j.lrcStatus,
          retryCount: j.retryCount,
          logs: (j.logs || []).slice(-20),
        }));

        const tempFile = `${this.stateFilePath}.tmp.${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        fs.writeFileSync(tempFile, JSON.stringify(cleanJobs, null, 2), 'utf-8');
        fs.renameSync(tempFile, this.stateFilePath);
      } catch {}
    };

    if (immediate) {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      doSave();
    } else {
      if (!this.persistTimer) {
        this.persistTimer = setTimeout(() => {
          this.persistTimer = null;
          doSave();
        }, 300);
      }
    }
  }

  public shutdown() {
    this.isPaused = true;
    for (const [id, executor] of this.activeExecutors.entries()) {
      try {
        executor.abort();
      } catch {}
    }
    this.activeExecutors.clear();
    this.savePersistedQueue(true);
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
      this.savePersistedQueue(false);
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
        this.savePersistedQueue(false);
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
    this.savePersistedQueue(true);

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
        job.retryCount = 0;
        job.audioTask = undefined;
        job.lyricsTask = undefined;
        this.emit('job_updated', job);
        count++;
      }
    }
    this.savePersistedQueue(true);
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
    job.retryCount = 0;
    job.audioTask = undefined;
    job.lyricsTask = undefined;
    this.addLog('INFO', `Retrying job: ${job.fileName}`, job.id);
    this.emit('job_updated', job);
    this.savePersistedQueue(true);
    this.emit('status_changed', this.getSystemSummary());
    this.notifyWorker();
  }

  clearCompleted() {
    const beforeCount = this.queue.length;
    this.queue = this.queue.filter(j => j.status !== 'COMPLETE' && j.status !== 'SKIPPED');
    const removed = beforeCount - this.queue.length;
    this.addLog('INFO', `Cleared ${removed} completed/skipped jobs from queue.`);
    this.savePersistedQueue(true);
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
      this.savePersistedQueue(true);
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
              const isTransient = !err.includes('CUDA/RTX 3060 is required') &&
                                  !err.includes('Original audio file does not exist') &&
                                  !err.includes('Source file missing');
              const maxRetries = 2;
              const currentRetries = j.retryCount || 0;

              if (isTransient && currentRetries < maxRetries) {
                j.retryCount = currentRetries + 1;
                j.status = 'QUEUED';
                j.currentPhase = 'Detecting';
                j.progress = 0;
                j.error = undefined;
                j.phaseMessage = `Retrying after transient error (attempt ${j.retryCount}/${maxRetries}): ${err}`;
                this.addLog('WARN', `Auto-retrying job "${j.fileName}" (attempt ${j.retryCount}/${maxRetries}): ${err}`, j.id);
                this.emitJobUpdated(j, true);
              } else {
                j.status = 'FAILED';
                j.currentPhase = 'Failed';
                j.error = err;
                j.phaseMessage = `Failed: ${err}`;
                j.completedAt = Date.now();
                this.emitJobUpdated(j, true);
              }
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
