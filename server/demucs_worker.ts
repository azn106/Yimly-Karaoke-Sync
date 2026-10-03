import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { EngineLog } from '../src/types.js';

export interface DemucsWorkerMetrics {
  workerSpawnCount: number;
  modelInitCount: number;
  jobsHandledCount: number;
  isRunning: boolean;
}

export class DemucsWorkerManager {
  private child: ChildProcess | null = null;
  private startingPromise: Promise<void> | null = null;
  public scriptPath: string | null = null;
  private workerSpawnCount = 0;
  private modelInitCount = 0;
  private jobsHandledCount = 0;
  private jobTimeoutMs = 300000; // 5 minutes default timeout per stem separation job
  private currentJob: {
    resolve: () => void;
    reject: (err: Error) => void;
    onProgress: (pct: number, msg: string) => void;
    onLog: (level: EngineLog['level'], msg: string) => void;
    watchdogTimer?: NodeJS.Timeout;
  } | null = null;

  public getMetrics(): DemucsWorkerMetrics {
    return {
      workerSpawnCount: this.workerSpawnCount,
      modelInitCount: this.modelInitCount,
      jobsHandledCount: this.jobsHandledCount,
      isRunning: this.child !== null && !this.child.killed,
    };
  }

  public resetMetrics() {
    this.workerSpawnCount = 0;
    this.modelInitCount = 0;
    this.jobsHandledCount = 0;
  }

  public stopWorker() {
    this.startingPromise = null;
    if (this.currentJob?.watchdogTimer) {
      clearTimeout(this.currentJob.watchdogTimer);
    }
    if (this.child) {
      const proc = this.child;
      this.child = null;
      proc.removeAllListeners();
      try {
        proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (!proc.killed) proc.kill('SIGKILL');
          } catch {}
        }, 1000);
      } catch {}
    }
    if (this.currentJob) {
      const jobRef = this.currentJob;
      this.currentJob = null;
      jobRef.reject(new Error('Demucs worker stopped'));
    }
  }

  public ensureWorker(pythonBin: string, modelsDir: string): Promise<void> {
    if (this.child && !this.child.killed) {
      return Promise.resolve();
    }
    if (this.startingPromise) {
      return this.startingPromise;
    }

    this.startingPromise = new Promise<void>((resolve, reject) => {
      const splitScriptPath = this.scriptPath || path.join(process.cwd(), 'split.py');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      };
      if (modelsDir) {
        env.TORCH_HOME = modelsDir;
        env.HF_HOME = modelsDir;
        env.XDG_CACHE_HOME = modelsDir;
      }

      const args = [splitScriptPath, '--worker'];
      const child = spawn(pythonBin, args, { cwd: process.cwd(), env });

      this.child = child;
      this.workerSpawnCount++;
      this.modelInitCount++;

      let isReady = false;

      const handleStdout = (chunk: Buffer) => {
        const str = chunk.toString();
        const lines = str.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed === '[WORKER_READY]') {
            if (!isReady) {
              isReady = true;
              this.startingPromise = null;
              resolve();
            }
          } else if (trimmed.startsWith('[WORKER_RESULT]')) {
            const jsonStr = trimmed.substring('[WORKER_RESULT]'.length).trim();
            if (this.currentJob) {
              const jobRef = this.currentJob;
              this.currentJob = null;
              if (jobRef.watchdogTimer) clearTimeout(jobRef.watchdogTimer);
              this.jobsHandledCount++;
              try {
                const res = JSON.parse(jsonStr);
                if (res.ok) {
                  jobRef.resolve();
                } else {
                  jobRef.reject(new Error(res.error || 'Demucs worker separation failed'));
                }
              } catch (e: any) {
                jobRef.reject(new Error(`Failed to parse worker result: ${e.message}`));
              }
            }
          } else {
            if (this.currentJob) {
              this.currentJob.onLog('INFO', trimmed);
            }
          }
        }
      };

      const handleStderr = (chunk: Buffer) => {
        const str = chunk.toString();
        const lines = str.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith('[PROG]')) {
            const match = trimmed.match(/^\[PROG\]\s+(\d+)\s*(.*)$/);
            if (match && this.currentJob) {
              this.currentJob.onProgress(parseInt(match[1], 10), match[2]);
            }
          } else if (trimmed.startsWith('[INFO]')) {
            if (this.currentJob) this.currentJob.onLog('INFO', trimmed.substring(6).trim());
          } else if (trimmed.startsWith('[WARN]')) {
            if (this.currentJob) this.currentJob.onLog('WARN', trimmed.substring(6).trim());
          } else if (trimmed.startsWith('[ERR ]') || trimmed.startsWith('[ERR]')) {
            if (this.currentJob) this.currentJob.onLog('ERR', trimmed.replace(/^\[ERR\s*\]/, '').trim());
          } else {
            if (this.currentJob) this.currentJob.onLog('INFO', trimmed);
          }
        }
      };

      child.stdout.on('data', handleStdout);
      child.stderr.on('data', handleStderr);

      child.on('error', (err) => {
        this.child = null;
        this.startingPromise = null;
        if (!isReady) {
          reject(new Error(`Failed to start Demucs persistent worker: ${err.message}`));
        } else if (this.currentJob) {
          const jobRef = this.currentJob;
          this.currentJob = null;
          if (jobRef.watchdogTimer) clearTimeout(jobRef.watchdogTimer);
          jobRef.reject(new Error(`Demucs worker error: ${err.message}`));
        }
      });

      child.on('exit', (code, signal) => {
        this.child = null;
        this.startingPromise = null;
        if (!isReady) {
          reject(new Error(`Demucs persistent worker exited during startup with code ${code} / signal ${signal}`));
        } else if (this.currentJob) {
          const jobRef = this.currentJob;
          this.currentJob = null;
          if (jobRef.watchdogTimer) clearTimeout(jobRef.watchdogTimer);
          jobRef.reject(new Error(`Demucs persistent worker terminated unexpectedly (code ${code}, signal ${signal})`));
        }
      });
    });

    return this.startingPromise;
  }

  public async runJob(
    pythonBin: string,
    splitReqPath: string,
    splitStatusPath: string,
    modelsDir: string,
    onProgress: (pct: number, msg: string) => void,
    onLog: (level: EngineLog['level'], msg: string) => void
  ): Promise<void> {
    await this.ensureWorker(pythonBin, modelsDir);

    if (!this.child || !this.child.stdin || this.child.killed) {
      throw new Error('Demucs worker process is not active');
    }

    return new Promise((resolve, reject) => {
      const watchdogTimer = setTimeout(() => {
        if (this.currentJob) {
          onLog('ERR', `Demucs worker job timed out after ${this.jobTimeoutMs / 1000}s. Terminating hung worker...`);
          this.stopWorker();
          reject(new Error(`Demucs worker separation timed out after ${this.jobTimeoutMs / 1000}s`));
        }
      }, this.jobTimeoutMs);

      this.currentJob = { resolve, reject, onProgress, onLog, watchdogTimer };
      const cmdLine = JSON.stringify({ request_file: splitReqPath, status_file: splitStatusPath }) + '\n';
      this.child!.stdin!.write(cmdLine, 'utf-8', (err) => {
        if (err && this.currentJob) {
          clearTimeout(watchdogTimer);
          const jobRef = this.currentJob;
          this.currentJob = null;
          this.stopWorker();
          jobRef.reject(new Error(`Failed to send request to Demucs worker: ${err.message}`));
        }
      });
    });
  }
}

export const demucsWorkerManager = new DemucsWorkerManager();
