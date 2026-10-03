import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { SyncJob, ProcessingPhase, EngineLog, SubTaskStatus, SubTaskState } from '../src/types.js';
import { getSettings } from './config.js';
import { extractMetadata, createInstrumentalWithFFmpeg } from './metadata.js';
import { findExistingInstrumental, findExistingElrc, findExistingNormalLrc, updateSingleSongInIndex } from './scanner.js';
import { fetchSongDualLyrics, PROVIDER_DISPLAY_NAMES } from './lyrics/manager.js';
import { verifyCudaGpu, CudaPreflightResult } from './diagnostics.js';
import { demucsWorkerManager } from './demucs_worker.js';

export interface ExecutionCallbacks {
  onProgress: (jobId: string, phase: ProcessingPhase, progress: number, message: string) => void;
  onSubTaskProgress?: (jobId: string, task: 'audio' | 'lyrics', progress: number, message: string, status?: SubTaskStatus) => void;
  onLog: (log: EngineLog) => void;
  onSegment: (jobId: string, seg: { start: number; end: number; text: string }) => void;
  onWord: (jobId: string, word: { time: number; userWord: string; whisperWord: string }) => void;
  onComplete: (jobId: string) => void;
  onFailed: (jobId: string, error: string) => void;
}

function atomicWriteFile(targetPath: string, content: string) {
  const tempPath = `${targetPath}.tmp.${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  try {
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, targetPath);
  } catch (err) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
    throw err;
  }
}

export function cleanupStaleTempWorkspaces(tempDir: string) {
  try {
    if (!fs.existsSync(tempDir)) return;
    const entries = fs.readdirSync(tempDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('job_')) {
        const fullPath = path.join(tempDir, entry.name);
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } catch {}
      }
    }
  } catch {}
}

export class JobExecutor {
  private activeAudioProcess: ChildProcess | null = null;
  private lyricsAbortController: AbortController | null = null;
  private isAborted = false;
  private activeTempDir: string | null = null;

  // Optional mock delegates for unit, regression, and hardware validation tests
  public customCudaValidator?: (pythonPath: string) => Promise<CudaPreflightResult>;
  public customPythonRunner?: (
    pythonBin: string,
    args: string[],
    modelsDir: string,
    onProgress: (pct: number, msg: string) => void,
    onLog: (level: EngineLog['level'], msg: string) => void
  ) => Promise<void>;
  public customFfmpegCreator?: typeof createInstrumentalWithFFmpeg;
  public customLyricsFetcher?: (
    title: string,
    artist: string,
    album?: string,
    duration?: number,
    opts?: any
  ) => Promise<{
    elrcResult?: { elrc?: string; format: string; source: string; lineCount: number } | null;
    lrcResult?: { lrc?: string; source: string; lineCount: number } | null;
  }>;

  async executeJob(
    job: SyncJob,
    callbacks: ExecutionCallbacks,
    resourceHooks?: {
      acquireAudioSlot?: () => Promise<() => void>;
      acquireLyricsSlot?: () => Promise<() => void>;
    }
  ): Promise<void> {
    const settings = getSettings();
    const originalPath = job.filePath;
    const dir = path.dirname(originalPath);
    const ext = path.extname(originalPath);
    const basename = path.basename(originalPath, ext);
    const expectedInstrumental = path.join(dir, `${basename} (Instrumental)${ext}`);
    const expectedElrc = path.join(dir, `${basename}.elrc.lrc`);
    const expectedLrc = path.join(dir, `${basename}.lrc`);

    const log = (level: EngineLog['level'], msg: string) => {
      callbacks.onLog({
        id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        timestamp: Date.now(),
        level,
        message: msg,
        jobId: job.id,
      });
    };

    const updateSubTask = (task: 'audio' | 'lyrics', patch: Partial<SubTaskState>) => {
      if (task === 'audio') {
        job.audioTask = {
          status: 'PROCESSING',
          progress: 0,
          ...job.audioTask,
          ...patch,
        };
      } else {
        job.lyricsTask = {
          status: 'PROCESSING',
          progress: 0,
          ...job.lyricsTask,
          ...patch,
        };
      }

      // Compute composite progress
      const audioProg = job.audioTask?.progress ?? 0;
      const lyricsProg = job.lyricsTask?.progress ?? 0;
      const compositeProgress = Math.round((audioProg + lyricsProg) / 2);

      // Determine human-readable phase
      let currentPhase: ProcessingPhase = 'Detecting';
      if (job.audioTask?.status === 'PROCESSING' && job.lyricsTask?.status === 'PROCESSING') {
        currentPhase = 'Separating vocals';
      } else if (job.audioTask?.status === 'PROCESSING') {
        currentPhase = 'Creating instrumental';
      } else if (job.lyricsTask?.status === 'PROCESSING') {
        currentPhase = 'Fetching eLRC';
      } else if (job.audioTask?.status === 'COMPLETE' && job.lyricsTask?.status === 'COMPLETE') {
        currentPhase = 'Verifying outputs';
      }

      const statusMsg = `Audio: ${job.audioTask?.status} (${audioProg}%) | Lyrics: ${job.lyricsTask?.status} (${lyricsProg}%)`;

      if (callbacks.onSubTaskProgress) {
        callbacks.onSubTaskProgress(
          job.id,
          task,
          task === 'audio' ? audioProg : lyricsProg,
          patch.message || statusMsg,
          patch.status
        );
      }

      callbacks.onProgress(job.id, currentPhase, compositeProgress, statusMsg);
    };

    // Dedicated temporary working directory
    const jobTempDir = path.join(settings.tempDir, `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`);
    this.activeTempDir = jobTempDir;

    try {
      fs.mkdirSync(jobTempDir, { recursive: true });
    } catch (e) {
      log('ERR', `Failed to create temp directory ${jobTempDir}: ${e}`);
    }

    log('INFO', `Starting concurrent processing job for: "${job.fileName}" in ${dir}`);

    try {
      // Initialize subtask states early
      if (!job.audioTask) {
        job.audioTask = { status: 'QUEUED', progress: 0, message: 'Queued for Demucs stem separation' };
      }
      if (!job.lyricsTask) {
        job.lyricsTask = { status: 'QUEUED', progress: 0, message: 'Queued for dual lyrics retrieval' };
      }

      // ----------------------------------------------------
      // 1. PHASE: Detecting & Preparing (Inspect inputs & existing outputs)
      // ----------------------------------------------------
      callbacks.onProgress(job.id, 'Detecting', 5, 'Checking file validity and reading tags...');
      
      if (!fs.existsSync(originalPath)) {
        throw new Error(`Original audio file does not exist: ${originalPath}`);
      }

      const metadata = await extractMetadata(originalPath);
      const songTitle = metadata.title || basename;
      const artistName = metadata.artist || job.artistName || 'Unknown Artist';
      const albumName = metadata.album || '';
      const duration = metadata.duration;

      log('INFO', `Metadata extracted: Title="${songTitle}", Artist="${artistName}", Album="${albumName}", Duration=${duration ? duration.toFixed(1) + 's' : 'unknown'}`);

      // Check existing outputs on disk
      const existingInstrumental = findExistingInstrumental(originalPath);
      const existingElrc = findExistingElrc(originalPath);
      const existingLrc = findExistingNormalLrc(originalPath);

      log('INFO', `Existing outputs check: Instrumental=${existingInstrumental ? path.basename(existingInstrumental) : 'NONE'}, eLRC=${existingElrc ? path.basename(existingElrc) : 'NONE'}, LRC=${existingLrc ? path.basename(existingLrc) : 'NONE'}`);

      // Initialize subtask states
      job.audioTask = existingInstrumental
        ? { status: 'COMPLETE', progress: 100, message: `Existing instrumental: ${path.basename(existingInstrumental)}`, device: 'cache' }
        : { status: 'QUEUED', progress: 0, message: 'Queued for Demucs stem separation' };

      job.lyricsTask = (existingElrc && existingLrc)
        ? { status: 'COMPLETE', progress: 100, message: 'Existing eLRC and LRC found', device: 'cache' }
        : { status: 'QUEUED', progress: 0, message: 'Queued for dual lyrics retrieval' };

      if (existingInstrumental) job.instrumentalStatus = 'EXISTS';
      if (existingElrc) job.elrcStatus = 'EXISTS';
      if (existingLrc) job.lrcStatus = 'EXISTS';

      // ----------------------------------------------------
      // 2. CONCURRENT EXECUTION: Audio Task & Lyrics Task
      // ----------------------------------------------------
      log('INFO', `Dispatching independent tasks: Audio (Demucs) + Lyrics (NetEase/QQ/Kugou/Musixmatch)`);

      const audioPromise = (async () => {
        if (existingInstrumental) {
          log('INFO', `Found existing matching instrumental: "${path.basename(existingInstrumental)}". Skipping Demucs separation.`);
          updateSubTask('audio', { status: 'COMPLETE', progress: 100, message: 'Existing instrumental verified', device: 'cache' });
          return;
        }

        let releaseSlot: (() => void) | null = null;
        try {
          if (resourceHooks?.acquireAudioSlot) {
            updateSubTask('audio', { status: 'QUEUED', progress: 0, message: 'Waiting for audio separation slot...' });
            releaseSlot = await resourceHooks.acquireAudioSlot();
          }

          if (this.isAborted) return;

          // ----------------------------------------------------
          // MANDATORY PRE-FLIGHT CUDA VALIDATION (NO CPU FALLBACK)
          // ----------------------------------------------------
          updateSubTask('audio', {
            status: 'PROCESSING',
            progress: 2,
            message: 'Verifying mandatory CUDA/RTX 3060 acceleration...',
            startedAt: Date.now(),
          });

          const cudaValidatorFn = this.customCudaValidator || verifyCudaGpu;
          const cudaCheck = await cudaValidatorFn(settings.pythonPath || 'python3');

          if (!cudaCheck.ready || !cudaCheck.tensorVerified) {
            const cudaErrMsg = 'CUDA/RTX 3060 is required for audio separation but is unavailable.';
            job.instrumentalStatus = 'FAILED';
            job.executionDevice = 'none';
            log('ERR', `${cudaErrMsg} Demucs CPU fallback is strictly disabled.`);
            if (cudaCheck.error) {
              log('ERR', `CUDA pre-flight check detail: ${cudaCheck.error}`);
            }
            updateSubTask('audio', {
              status: 'FAILED',
              progress: 0,
              error: cudaErrMsg,
              message: cudaErrMsg,
              completedAt: Date.now(),
            });
            return; // Abort audio branch immediately before starting Demucs! Never run on CPU!
          }

          const gpuDeviceName = cudaCheck.deviceName || 'NVIDIA GeForce RTX 3060';
          const gpuVramStr = cudaCheck.vramGb ? ` (${cudaCheck.vramGb} GB VRAM)` : '';
          job.executionDevice = 'cuda';
          log('INFO', `Audio device: CUDA — ${gpuDeviceName}${gpuVramStr}`);
          log('INFO', `CUDA device 0 & tensor operations verified. Starting Demucs (${settings.demucs.model || 'htdemucs'})...`);

          updateSubTask('audio', {
            status: 'PROCESSING',
            progress: 5,
            device: 'cuda',
            message: `Audio device: CUDA — ${gpuDeviceName}. Invoking Demucs...`,
            startedAt: Date.now(),
          });

          const demucsFormat = (ext === '.flac' ? 'flac' : (ext === '.mp3' ? 'mp3' : 'wav')) as 'flac' | 'mp3' | 'wav';
          const splitReqPath = path.join(jobTempDir, 'split_request.json');
          const splitStatusPath = path.join(jobTempDir, 'split_status.json');

          const splitRequest = {
            audio: originalPath,
            out_dir: jobTempDir,
            model: settings.demucs.model || 'htdemucs',
            stems: 'vocals', // 2-stem separation -> "vocals" & "no_vocals" (instrumental)
            format: demucsFormat,
            mp3_bitrate: settings.demucs.mp3Bitrate || 320,
            shifts: settings.demucs.shifts || 1,
            overlap: settings.demucs.overlap || 0.25,
            use_gpu: true,
            require_cuda: true,
          };

          fs.writeFileSync(splitReqPath, JSON.stringify(splitRequest, null, 2), 'utf-8');
          const splitScriptPath = settings.splitScriptPath || path.join(process.cwd(), 'split.py');

          if (fs.existsSync(splitScriptPath)) {
            if (this.customPythonRunner) {
              await this.customPythonRunner(
                settings.pythonPath || 'python3',
                [splitScriptPath, splitReqPath, splitStatusPath],
                settings.modelsDir || '',
                (prog: number, msg: string) => {
                  const audioPct = Math.round(5 + (prog * 0.80));
                  updateSubTask('audio', { progress: audioPct, message: msg || 'Demucs separating stems...' });
                },
                log
              );
            } else {
              await demucsWorkerManager.runJob(
                settings.pythonPath || 'python3',
                splitReqPath,
                splitStatusPath,
                settings.modelsDir || '',
                (prog: number, msg: string) => {
                  const audioPct = Math.round(5 + (prog * 0.80));
                  updateSubTask('audio', { progress: audioPct, message: msg || 'Demucs separating stems...' });
                },
                log
              );
            }

            // Read device actually used from split_status.json
            if (fs.existsSync(splitStatusPath)) {
              try {
                const statusJson = JSON.parse(fs.readFileSync(splitStatusPath, 'utf-8'));
                if (!statusJson.ok || statusJson.device !== 'cuda') {
                  const failureReason = statusJson.error || 'CUDA/RTX 3060 is required for audio separation but was not used by Demucs.';
                  throw new Error(failureReason);
                }
                job.executionDevice = 'cuda';
                log('INFO', `Demucs stem separation confirmed executed on CUDA (${statusJson.gpu_name || gpuDeviceName}).`);
              } catch (parseErr: any) {
                if (parseErr.message?.includes('CUDA/RTX 3060')) throw parseErr;
                job.executionDevice = 'cuda';
              }
            } else {
              job.executionDevice = 'cuda';
              log('INFO', `Demucs stem separation process completed.`);
            }

            // Locate no_vocals stem
            const trackDir = path.join(jobTempDir, settings.demucs.model || 'htdemucs', basename);
            const stemCandidates = [
              path.join(trackDir, `no_vocals.${demucsFormat}`),
              path.join(trackDir, 'no_vocals.wav'),
              path.join(trackDir, 'no_vocals.flac'),
              path.join(trackDir, 'no_vocals.mp3'),
            ];

            let isolatedStem: string | null = null;
            for (const cand of stemCandidates) {
              if (fs.existsSync(cand)) {
                isolatedStem = cand;
                break;
              }
            }

            if (!isolatedStem && fs.existsSync(trackDir)) {
              const files = fs.readdirSync(trackDir);
              const found = files.find(f => f.toLowerCase().includes('no_vocals') || f.toLowerCase().includes('accompaniment'));
              if (found) {
                isolatedStem = path.join(trackDir, found);
              }
            }

            if (isolatedStem) {
              updateSubTask('audio', { progress: 88, message: `FFmpeg encoding ${path.basename(expectedInstrumental)}...` });
              const ffmpegFn = this.customFfmpegCreator || createInstrumentalWithFFmpeg;
              await ffmpegFn(
                originalPath,
                isolatedStem,
                expectedInstrumental,
                metadata,
                (msg) => log('INFO', msg)
              );

              if (fs.existsSync(expectedInstrumental)) {
                job.instrumentalStatus = 'GENERATED';
                log('INFO', `Successfully generated instrumental: "${path.basename(expectedInstrumental)}"`);
                updateSubTask('audio', {
                  status: 'COMPLETE',
                  progress: 100,
                  message: 'Instrumental generated successfully',
                  device: 'cuda',
                  completedAt: Date.now(),
                });
              } else {
                job.instrumentalStatus = 'FAILED';
                log('WARN', `Demucs stem was isolated, but FFmpeg failed to output ${expectedInstrumental}`);
                updateSubTask('audio', { status: 'FAILED', error: 'FFmpeg encoding failed', message: 'FFmpeg output missing' });
              }
            } else {
              job.instrumentalStatus = 'FAILED';
              log('WARN', `Demucs ran but no_vocals stem was not located in ${trackDir}`);
              updateSubTask('audio', { status: 'FAILED', error: 'No vocal stem found', message: 'Stem missing' });
            }
          } else {
            job.instrumentalStatus = 'SKIPPED';
            log('WARN', `split.py script not found at ${splitScriptPath}. Skipping Demucs.`);
            updateSubTask('audio', { status: 'SKIPPED', message: 'split.py not found' });
          }
        } catch (demucsErr: any) {
          // Demucs failure MUST NOT block lyric retrieval or crash the song
          job.instrumentalStatus = 'FAILED';
          log('ERR', `Demucs stem separation failed: ${demucsErr.message}`);
          updateSubTask('audio', {
            status: 'FAILED',
            error: demucsErr.message,
            message: `Audio failed: ${demucsErr.message}`,
          });
        } finally {
          if (releaseSlot) releaseSlot();
        }
      })();

      const lyricsPromise = (async () => {
        if (existingElrc && existingLrc) {
          log('INFO', `Existing .elrc.lrc and .lrc present. Skipping lyric fetch.`);
          updateSubTask('lyrics', { status: 'COMPLETE', progress: 100, message: 'Existing lyrics verified', device: 'cache' });
          return;
        }

        let releaseSlot: (() => void) | null = null;
        try {
          if (resourceHooks?.acquireLyricsSlot) {
            updateSubTask('lyrics', { status: 'QUEUED', progress: 0, message: 'Waiting for lyrics slot...' });
            releaseSlot = await resourceHooks.acquireLyricsSlot();
          }

          if (this.isAborted) return;

          updateSubTask('lyrics', {
            status: 'PROCESSING',
            progress: 10,
            message: `Querying providers for "${songTitle}"...`,
            startedAt: Date.now(),
            device: 'network',
          });

          this.lyricsAbortController = new AbortController();

          let dualResult: {
            elrcResult?: { elrc?: string; format: string; source: string; lineCount: number } | null;
            lrcResult?: { lrc?: string; source: string; lineCount: number } | null;
          };

          if (this.customLyricsFetcher) {
            dualResult = await this.customLyricsFetcher(songTitle, artistName, albumName, duration, {
              leadInMs: settings.lyrics?.elrcLineLeadInMs,
              needElrc: !existingElrc,
              needLrc: !existingLrc,
              onLog: (m: string) => log('INFO', m),
            });
          } else {
            dualResult = await fetchSongDualLyrics(songTitle, artistName, albumName, duration, {
              leadInMs: settings.lyrics?.elrcLineLeadInMs,
              needElrc: !existingElrc,
              needLrc: !existingLrc,
              onLog: (m) => log('INFO', m),
            });
          }

          updateSubTask('lyrics', { progress: 80, message: 'Writing lyric files to disk...' });

          // Handle word-synced .elrc.lrc
          if (!existingElrc) {
            if (dualResult.elrcResult?.elrc) {
              atomicWriteFile(expectedElrc, dualResult.elrcResult.elrc);
              job.elrcStatus = 'FETCHED';
              const provName = PROVIDER_DISPLAY_NAMES[dualResult.elrcResult.source] || dualResult.elrcResult.source;
              log('INFO', `Saved word-synced eLRC (${dualResult.elrcResult.format} via ${provName}) to "${path.basename(expectedElrc)}" (${dualResult.elrcResult.lineCount} lines).`);
            } else {
              job.elrcStatus = 'NOT_FOUND';
              log('WARN', `Word-synced .elrc.lrc unavailable across all providers for "${songTitle}".`);
            }
          }

          // Handle standard line-synced .lrc
          if (!existingLrc) {
            if (dualResult.lrcResult?.lrc) {
              atomicWriteFile(expectedLrc, dualResult.lrcResult.lrc);
              job.lrcStatus = 'FETCHED';
              const provName = PROVIDER_DISPLAY_NAMES[dualResult.lrcResult.source] || dualResult.lrcResult.source;
              log('INFO', `Saved standard line-synced LRC (via ${provName}) to "${path.basename(expectedLrc)}" (${dualResult.lrcResult.lineCount} lines).`);
            } else {
              job.lrcStatus = 'NOT_FOUND';
              log('WARN', `Standard line-synced .lrc unavailable across all providers for "${songTitle}".`);
            }
          }

          const hasAnyFetched = job.elrcStatus === 'FETCHED' || job.lrcStatus === 'FETCHED';
          const hasAnyExists = existingElrc || existingLrc;

          updateSubTask('lyrics', {
            status: (hasAnyFetched || hasAnyExists) ? 'COMPLETE' : 'FAILED',
            progress: 100,
            message: (hasAnyFetched || hasAnyExists) ? 'Lyrics retrieval complete' : 'Lyrics not found on providers',
            completedAt: Date.now(),
          });
        } catch (dualErr: any) {
          log('WARN', `Error during dual lyric retrieval: ${dualErr.message}`);
          if (!existingElrc) job.elrcStatus = 'NOT_FOUND';
          if (!existingLrc) job.lrcStatus = 'NOT_FOUND';
          updateSubTask('lyrics', {
            status: 'FAILED',
            error: dualErr.message,
            message: `Lyrics error: ${dualErr.message}`,
          });
        } finally {
          this.lyricsAbortController = null;
          if (releaseSlot) releaseSlot();
        }
      })();

      // ----------------------------------------------------
      // 3. PHASE: Wait for both independent tasks to settle
      // ----------------------------------------------------
      await Promise.allSettled([audioPromise, lyricsPromise]);

      // ----------------------------------------------------
      // 4. PHASE: Final Synchronization & Output Verification
      // ----------------------------------------------------
      callbacks.onProgress(job.id, 'Verifying outputs', 95, 'Verifying generated outputs on disk...');

      const finalInst = findExistingInstrumental(originalPath);
      const finalElrc = findExistingElrc(originalPath);
      const finalLrc = findExistingNormalLrc(originalPath);

      log('INFO', `Execution summary for "${songTitle}":`);
      log('INFO', `  - Instrumental: ${finalInst ? `[OK] (${path.basename(finalInst)})` : '[MISSING]'}`);
      log('INFO', `  - eLRC (.elrc.lrc): ${finalElrc ? `[OK] (${path.basename(finalElrc)})` : '[MISSING]'}`);
      log('INFO', `  - LRC (.lrc): ${finalLrc ? `[OK] (${path.basename(finalLrc)})` : '[MISSING]'}`);

      // ----------------------------------------------------
      // 5. PHASE: Cleanup temporary workspace
      // ----------------------------------------------------
      callbacks.onProgress(job.id, 'Cleaning temporary files', 99, 'Cleaning temporary files...');
      this.cleanupTempDir(jobTempDir, log);

      // Update in-memory library index with verified outputs
      try {
        await updateSingleSongInIndex(originalPath, settings.mediaRoot);
      } catch {}

      // Determine final status
      const audioSuccess = Boolean(finalInst) || job.audioTask?.status === 'COMPLETE' || job.instrumentalStatus === 'EXISTS';
      const lyricsSuccess = Boolean(finalElrc || finalLrc) || job.lyricsTask?.status === 'COMPLETE';

      if (audioSuccess && lyricsSuccess) {
        callbacks.onProgress(job.id, 'Complete', 100, 'Processing completed successfully.');
        callbacks.onComplete(job.id);
      } else if (lyricsSuccess && !audioSuccess) {
        callbacks.onProgress(job.id, 'Complete', 100, 'Lyrics completed (Audio failed: CUDA/RTX 3060 unavailable)');
        callbacks.onComplete(job.id);
      } else if (audioSuccess && !lyricsSuccess) {
        callbacks.onProgress(job.id, 'Complete', 100, 'Audio completed (Lyrics not found)');
        callbacks.onComplete(job.id);
      } else {
        const failureMsg = `Failed to generate instrumental and fetch lyrics.`;
        callbacks.onProgress(job.id, 'Failed', 100, failureMsg);
        callbacks.onFailed(job.id, failureMsg);
      }
    } catch (err: any) {
      log('ERR', `Job processing failed: ${err.message}`);
      this.cleanupTempDir(jobTempDir, log);
      callbacks.onFailed(job.id, err.message);
    }
  }

  private runPythonScript(
    pythonBin: string,
    args: string[],
    modelsDir: string,
    onProgress: (pct: number, msg: string) => void,
    onLog: (level: EngineLog['level'], msg: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      onLog('INFO', `Spawning Demucs subprocess: ${pythonBin} ${args.map(a => `"${a}"`).join(' ')}`);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      };

      if (modelsDir) {
        env.TORCH_HOME = modelsDir;
        env.HF_HOME = modelsDir;
        env.XDG_CACHE_HOME = modelsDir;
      }

      const child = spawn(pythonBin, args, {
        cwd: process.cwd(),
        env,
      });

      this.activeAudioProcess = child;
      let stderrBuffer = '';

      child.stderr.on('data', (chunk) => {
        const str = chunk.toString();
        stderrBuffer += str;
        const lines = str.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith('[PROG]')) {
            const match = trimmed.match(/^\[PROG\]\s+(\d+)\s*(.*)$/);
            if (match) {
              const pct = parseInt(match[1], 10);
              const msg = match[2];
              onProgress(pct, msg);
            }
          } else if (trimmed.startsWith('[INFO]')) {
            onLog('INFO', trimmed.substring(6).trim());
          } else if (trimmed.startsWith('[WARN]')) {
            onLog('WARN', trimmed.substring(6).trim());
          } else if (trimmed.startsWith('[ERR ]') || trimmed.startsWith('[ERR]')) {
            const errMsg = trimmed.replace(/^\[ERR\s*\]/, '').trim();
            onLog('ERR', errMsg);
          } else {
            onLog('INFO', trimmed);
          }
        }
      });

      child.stdout.on('data', (chunk) => {
        const str = chunk.toString().trim();
        if (str) onLog('INFO', str);
      });

      child.on('error', (err) => {
        this.activeAudioProcess = null;
        reject(new Error(`Failed to start Demucs process: ${err.message}`));
      });

      child.on('close', (code) => {
        this.activeAudioProcess = null;
        if (code === 0) {
          resolve();
        } else {
          const errLines = stderrBuffer
            .split('\n')
            .filter(l => l.includes('[ERR') || l.includes('Error:') || l.includes('traceback'))
            .join('\n');
          reject(new Error(errLines || `Demucs process exited with error code ${code}`));
        }
      });
    });
  }

  private cleanupTempDir(dir: string, log: (level: EngineLog['level'], msg: string) => void) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        log('INFO', `Cleaned temporary workspace at ${dir}`);
      }
    } catch (e: any) {
      log('WARN', `Could not clean temp directory ${dir}: ${e.message}`);
    } finally {
      if (this.activeTempDir === dir) {
        this.activeTempDir = null;
      }
    }
  }

  abort() {
    this.isAborted = true;
    if (this.activeAudioProcess) {
      try {
        this.activeAudioProcess.kill('SIGTERM');
      } catch {}
      this.activeAudioProcess = null;
    }
    if (this.lyricsAbortController) {
      try {
        this.lyricsAbortController.abort();
      } catch {}
      this.lyricsAbortController = null;
    }
    if (this.activeTempDir) {
      try {
        if (fs.existsSync(this.activeTempDir)) {
          fs.rmSync(this.activeTempDir, { recursive: true, force: true });
        }
      } catch {}
      this.activeTempDir = null;
    }
  }
}
