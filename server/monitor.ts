import fs from 'fs';
import path from 'path';
import { globalQueue } from './queue.js';
import { getSettings } from './config.js';
import { 
  scanMediaDirectory, 
  SUPPORTED_AUDIO_EXTS, 
  checkSongCompletion,
  updateSingleSongInIndex,
  removeSongFromIndex,
  handleCompanionFileChangeInIndex,
  isInstrumentalFilename
} from './scanner.js';

interface PendingFileCheck {
  filePath: string;
  artistName: string;
  lastSize: number;
  stableCount: number;
  detectedAt: number;
}

export class FileMonitor {
  private watcher: fs.FSWatcher | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private pendingFiles: Map<string, PendingFileCheck> = new Map();
  private stabilityInterval: NodeJS.Timeout | null = null;
  private isScanning = false;
  private knownFiles: Set<string> = new Set();

  // Debouncing for batching rapid filesystem events
  private pendingChangedPaths: Set<string> = new Set();
  private debounceTimer: NodeJS.Timeout | null = null;

  async start() {
    const settings = getSettings();
    const mediaRoot = settings.mediaRoot;

    globalQueue.addLog('INFO', `Starting Yimly Sync File Monitor on: ${mediaRoot}`);
    globalQueue.setMonitoring(true);

    // 1. Initial Startup Scan
    await this.runStartupScan();

    // 2. Start File Watcher & Poller
    this.setupWatcher(mediaRoot);
    this.startStabilityChecker();
  }

  async runStartupScan() {
    if (this.isScanning) return;
    this.isScanning = true;
    const settings = getSettings();
    const mediaRoot = settings.mediaRoot;

    globalQueue.addLog('INFO', `Running startup scan on ${mediaRoot}...`);

    try {
      const scanResult = await scanMediaDirectory(mediaRoot, true);
      globalQueue.addLog('INFO', `Startup scan finished. Total: ${scanResult.total} songs, Complete: ${scanResult.complete}, Incomplete: ${scanResult.incomplete}`);

      // Track all existing files
      this.knownFiles.clear();
      for (const song of scanResult.songs) {
        this.knownFiles.add(path.resolve(song.filePath));
        if (!song.isComplete) {
          globalQueue.enqueueSong(song.filePath, song.artistName, 'QUEUED');
        }
      }
    } catch (err: any) {
      globalQueue.addLog('ERR', `Error during startup scan: ${err.message}`);
    } finally {
      this.isScanning = false;
    }
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.stabilityInterval) {
      clearInterval(this.stabilityInterval);
      this.stabilityInterval = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    globalQueue.setMonitoring(false);
    globalQueue.addLog('INFO', 'Yimly Sync File Monitor stopped.');
  }

  private setupWatcher(mediaRoot: string) {
    if (!fs.existsSync(mediaRoot)) {
      try {
        fs.mkdirSync(mediaRoot, { recursive: true });
      } catch (e) {}
    }

    try {
      this.watcher = fs.watch(mediaRoot, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        this.queueFileChange(path.join(mediaRoot, filename));
      });
    } catch (err) {
      globalQueue.addLog('WARN', `Native recursive watcher error (${err}). Falling back to regular polling.`);
    }

    // Polling interval backup for robust cross-platform detection (lightweight)
    this.pollInterval = setInterval(() => {
      this.pollDirectory();
    }, 10000);
  }

  private queueFileChange(fullPath: string) {
    this.pendingChangedPaths.add(fullPath);
    if (!this.debounceTimer) {
      this.debounceTimer = setTimeout(() => {
        this.processDebouncedFileChanges();
      }, 150);
    }
  }

  private async processDebouncedFileChanges() {
    const pathsToProcess = Array.from(this.pendingChangedPaths);
    this.pendingChangedPaths.clear();
    this.debounceTimer = null;

    const settings = getSettings();

    for (const fullPath of pathsToProcess) {
      await this.handleFileChange(fullPath, settings.mediaRoot);
    }
  }

  private async handleFileChange(fullPath: string, mediaRoot: string) {
    const baseName = path.basename(fullPath);
    const lowerBase = baseName.toLowerCase();

    // Ignore temp vocal outputs, hidden files, or node_modules
    if (lowerBase.startsWith('.') || lowerBase.includes('_vocals.') || lowerBase.includes('htdemucs')) {
      return;
    }

    // Check if companion file (.lrc, .elrc.lrc, or instrumental)
    if (lowerBase.endsWith('.lrc') || isInstrumentalFilename(baseName)) {
      await handleCompanionFileChangeInIndex(fullPath, mediaRoot);
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    if (!SUPPORTED_AUDIO_EXTS.has(ext)) return;

    const absPath = path.resolve(fullPath);

    // If file was deleted from disk
    if (!fs.existsSync(fullPath)) {
      removeSongFromIndex(absPath);
      this.knownFiles.delete(absPath);
      if (this.pendingFiles.has(absPath)) {
        this.pendingFiles.delete(absPath);
      }
      globalQueue.removeJob(absPath);
      return;
    }

    // Update in-memory index incrementally
    await updateSingleSongInIndex(absPath, mediaRoot);

    const rel = path.relative(mediaRoot, path.dirname(absPath));
    const artistName = rel && rel !== '.' ? rel.split(path.sep)[0] : path.basename(path.dirname(absPath));

    // If file is newly discovered and incomplete, put into WAITING FOR FILE check
    const completion = checkSongCompletion(absPath);
    if (completion.isComplete) {
      this.knownFiles.add(absPath);
      return;
    }

    if (!this.knownFiles.has(absPath) && !this.pendingFiles.has(absPath)) {
      globalQueue.addLog('INFO', `DETECTED new audio file: ${path.basename(absPath)} in ${artistName}. Waiting for copy to complete...`);
      
      this.pendingFiles.set(absPath, {
        filePath: absPath,
        artistName,
        lastSize: -1,
        stableCount: 0,
        detectedAt: Date.now(),
      });

      // Show in UI with WAITING_FOR_FILE status
      globalQueue.enqueueSong(absPath, artistName, 'WAITING_FOR_FILE');
    }
  }

  private startStabilityChecker() {
    this.stabilityInterval = setInterval(() => {
      this.checkPendingFiles();
    }, 2000);
  }

  private async checkPendingFiles() {
    const settings = getSettings();
    for (const [filePath, pending] of this.pendingFiles.entries()) {
      if (!fs.existsSync(filePath)) {
        this.pendingFiles.delete(filePath);
        removeSongFromIndex(filePath);
        globalQueue.removeJob(filePath);
        continue;
      }

      try {
        const stats = fs.statSync(filePath);
        const currentSize = stats.size;

        if (currentSize > 0 && currentSize === pending.lastSize) {
          pending.stableCount++;
          
          // If size has stayed constant for 2 successive checks (~4s) and is readable
          if (pending.stableCount >= 2) {
            try {
              const fd = fs.openSync(filePath, 'r');
              fs.closeSync(fd);

              globalQueue.addLog('INFO', `File verified stable and readable: "${path.basename(filePath)}" (${(currentSize / (1024 * 1024)).toFixed(2)} MB)`);
              this.knownFiles.add(filePath);
              this.pendingFiles.delete(filePath);

              // Update index and enqueue song for processing
              await updateSingleSongInIndex(filePath, settings.mediaRoot);
              globalQueue.enqueueSong(filePath, pending.artistName, 'QUEUED');
            } catch (openErr) {
              // Still locked by copying process
              globalQueue.addLog('INFO', `File still being written: "${path.basename(filePath)}"`);
            }
          }
        } else {
          // File is still growing
          pending.lastSize = currentSize;
          pending.stableCount = 0;
          globalQueue.updateJobStatus(
            filePath,
            'WAITING_FOR_FILE',
            'Detecting',
            0,
            `Waiting for file write (${(currentSize / (1024 * 1024)).toFixed(2)} MB)...`
          );
        }
      } catch (err) {
        // File may be locked
      }
    }
  }

  private async pollDirectory() {
    const settings = getSettings();
    if (!fs.existsSync(settings.mediaRoot)) return;

    try {
      // Lightweight walk: only find audio file paths without extracting metadata
      const audioFiles: string[] = [];
      const walk = (dir: string) => {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (entry.name.startsWith('.') || entry.name === 'htdemucs' || entry.name === 'node_modules') continue;
              walk(full);
            } else if (entry.isFile()) {
              const ext = path.extname(entry.name).toLowerCase();
              if (SUPPORTED_AUDIO_EXTS.has(ext)) {
                audioFiles.push(full);
              }
            }
          }
        } catch {}
      };

      walk(settings.mediaRoot);

      // Reconcile newly appeared files
      for (const filePath of audioFiles) {
        const abs = path.resolve(filePath);
        if (!this.knownFiles.has(abs) && !this.pendingFiles.has(abs)) {
          this.queueFileChange(abs);
        }
      }

      // Reconcile deleted files
      for (const known of Array.from(this.knownFiles)) {
        if (!fs.existsSync(known)) {
          this.knownFiles.delete(known);
          removeSongFromIndex(known);
          globalQueue.removeJob(known);
        }
      }
    } catch {}
  }
}

export const globalMonitor = new FileMonitor();
