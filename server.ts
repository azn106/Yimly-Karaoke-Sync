import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { loadSettings, saveSettings, getSettings } from './server/config.js';
import { scanMediaDirectory } from './server/scanner.js';
import { globalQueue } from './server/queue.js';
import { globalMonitor } from './server/monitor.js';
import { runDiagnostics, runLiveGpuAudit } from './server/diagnostics.js';
import { ensureSampleLibrary } from './server/sampleData.js';
import { extractMetadata } from './server/metadata.js';
import { fetchUnifiedElrc, fetchUnifiedLrc, DEFAULT_PROVIDER_ORDER, PROVIDER_DISPLAY_NAMES, getActiveProviderList } from './server/lyrics/manager.js';

const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize settings
loadSettings();

// SSE Connected Clients
const sseClients: express.Response[] = [];

function broadcastSSE(eventType: string, data: any) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].write(payload);
    } catch {
      sseClients.splice(i, 1);
    }
  }
}

// Batch log items so rapid stdout from processing doesn't flood TCP packets and UI renders
let pendingLogs: any[] = [];
let logFlushTimer: NodeJS.Timeout | null = null;

function flushLogs() {
  if (pendingLogs.length === 0) return;
  const batch = pendingLogs;
  pendingLogs = [];
  logFlushTimer = null;
  if (batch.length === 1) {
    broadcastSSE('log', batch[0]);
  } else {
    broadcastSSE('logs_batch', batch);
  }
}

// Hook queue events to SSE
globalQueue.on('log', (logItem) => {
  pendingLogs.push(logItem);
  if (pendingLogs.length >= 15) {
    if (logFlushTimer) clearTimeout(logFlushTimer);
    flushLogs();
  } else if (!logFlushTimer) {
    logFlushTimer = setTimeout(flushLogs, 75);
  }
});

globalQueue.on('job_updated', (job) => broadcastSSE('job_updated', job));
globalQueue.on('job_removed', (jobId) => broadcastSSE('job_removed', { id: jobId }));
globalQueue.on('queue_cleared', () => broadcastSSE('queue_cleared', {}));
globalQueue.on('status_changed', (status) => broadcastSSE('status_changed', status));

// --------------------------------------------------------------------------
// API ROUTES
// --------------------------------------------------------------------------

// SSE Stream
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);

  // Send initial snapshot
  const initialData = {
    type: 'init',
    status: globalQueue.getSystemSummary(),
    jobs: globalQueue.getJobs(),
    logs: globalQueue.getLogs().slice(-100),
  };
  res.write(`event: init\ndata: ${JSON.stringify(initialData)}\n\n`);

  req.on('close', () => {
    const index = sseClients.indexOf(res);
    if (index !== -1) sseClients.splice(index, 1);
  });
});

// System Status & Summary
app.get('/api/status', async (req, res) => {
  const settings = getSettings();
  const summary = globalQueue.getSystemSummary();
  const scanResult = await scanMediaDirectory(settings.mediaRoot);
  const diagnostics = await runDiagnostics();

  res.json({
    status: {
      ...summary,
      totalSongs: scanResult.total,
      completedSongs: scanResult.complete,
      incompleteSongs: scanResult.incomplete,
      pythonInfo: diagnostics.python,
      ffmpegInfo: diagnostics.ffmpeg,
    },
  });
});

// Media Library Songs
app.get('/api/songs', async (req, res) => {
  const settings = getSettings();
  const scanResult = await scanMediaDirectory(settings.mediaRoot);
  res.json({
    songs: scanResult.songs,
    stats: {
      total: scanResult.total,
      complete: scanResult.complete,
      incomplete: scanResult.incomplete,
    },
  });
});

// Queue List
app.get('/api/queue', (req, res) => {
  res.json({
    jobs: globalQueue.getJobs(),
    activeJob: globalQueue.getActiveJob(),
    activeJobs: globalQueue.getActiveJobs(),
    isPaused: globalQueue.isQueuePaused(),
    isMonitoring: globalQueue.isMonitorRunning(),
  });
});

// Engine Logs
app.get('/api/logs', (req, res) => {
  res.json({
    logs: globalQueue.getLogs(),
  });
});

// Settings
app.get('/api/settings', (req, res) => {
  res.json({
    settings: getSettings(),
  });
});

app.post('/api/settings', async (req, res) => {
  const updated = saveSettings(req.body);
  globalQueue.addLog('INFO', `Settings updated. Media Root: ${updated.mediaRoot}, Model: ${updated.demucs.model}, GPU: ${updated.useGpu ? 'ON' : 'OFF'}`);
  
  // If media root changed, optionally rescan
  if (req.body.mediaRoot) {
    await globalMonitor.runStartupScan();
  }
  
  res.json({ success: true, settings: updated });
});

// Diagnostics
app.get('/api/diagnostics', async (req, res) => {
  const diag = await runDiagnostics();
  res.json(diag);
});

// Real GPU Workload Audit
app.get('/api/diagnostics/gpu-check', async (req, res) => {
  try {
    const gpuAudit = await runLiveGpuAudit();
    res.json(gpuAudit);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Monitor Controls
app.post('/api/monitor/start', async (req, res) => {
  await globalMonitor.start();
  res.json({ success: true, monitoring: true });
});

app.post('/api/monitor/stop', (req, res) => {
  globalMonitor.stop();
  res.json({ success: true, monitoring: false });
});

app.post('/api/monitor/scan', async (req, res) => {
  await globalMonitor.runStartupScan();
  const settings = getSettings();
  const scan = await scanMediaDirectory(settings.mediaRoot);
  res.json({ success: true, scan });
});

// Queue Controls
app.post('/api/queue/pause', (req, res) => {
  globalQueue.setQueuePaused(true);
  res.json({ success: true, paused: true });
});

app.post('/api/queue/resume', (req, res) => {
  globalQueue.setQueuePaused(false);
  res.json({ success: true, paused: false });
});

app.post('/api/queue/retry-failed', (req, res) => {
  globalQueue.retryFailed();
  res.json({ success: true });
});

app.post('/api/queue/retry/:id', (req, res) => {
  globalQueue.retryJob(req.params.id);
  res.json({ success: true });
});

app.post('/api/queue/clear-completed', (req, res) => {
  globalQueue.clearCompleted();
  res.json({ success: true });
});

app.post('/api/queue/remove/:id', (req, res) => {
  globalQueue.removeJob(req.params.id);
  res.json({ success: true });
});

app.post('/api/queue/enqueue', (req, res) => {
  const { filePath, artistName, force } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required' });
  }
  const job = globalQueue.enqueueSong(filePath, artistName || '', 'QUEUED', Boolean(force));
  res.json({ success: Boolean(job), job });
});

app.post('/api/queue/process-all-incomplete', async (req, res) => {
  const settings = getSettings();
  const scanResult = await scanMediaDirectory(settings.mediaRoot);
  let queued = 0;
  for (const song of scanResult.songs) {
    if (!song.isComplete) {
      const job = globalQueue.enqueueSong(song.filePath, song.artistName, 'QUEUED');
      if (job) queued++;
    }
  }
  globalQueue.addLog('INFO', `Queued ${queued} incomplete songs for processing.`);
  res.json({ success: true, queuedCount: queued });
});

app.post('/api/validate-path', (req, res) => {
  const { p, type } = req.body;
  if (!p) return res.json({ valid: false, error: 'No path provided' });
  try {
    const stats = fs.statSync(p);
    if (type === 'file' && !stats.isFile()) return res.json({ valid: false, error: 'Not a file' });
    if (type === 'folder' && !stats.isDirectory()) return res.json({ valid: false, error: 'Not a folder' });
    res.json({ valid: true });
  } catch (err: any) {
    res.json({ valid: false, error: err.message });
  }
});

// Helper: Add custom sample / new song to library for live copy detection simulation
app.post('/api/library/add-sample', (req, res) => {
  const { artist, title } = req.body;
  const settings = getSettings();
  const artistName = artist || 'Taylor Swift';
  const songTitle = title || 'Cruel Summer';
  const artistDir = path.join(settings.mediaRoot, artistName);

  try {
    fs.mkdirSync(artistDir, { recursive: true });
    const songPath = path.join(artistDir, `${songTitle}.flac`);
    const lrcPath = path.join(artistDir, `${songTitle}.lrc`);

    // Write lyrics
    fs.writeFileSync(
      lrcPath,
      `[00:00.00]Fever dream high in the quiet of the night\n[00:03.00]You know that I caught it\n[00:05.00]Bad, bad boy, shiny toy with a price\n[00:08.00]You know that I bought it`,
      'utf-8'
    );

    // Simulate file being written over 2 seconds
    fs.writeFileSync(songPath, Buffer.alloc(1024 * 50, 1));
    setTimeout(() => {
      try {
        fs.appendFileSync(songPath, Buffer.alloc(1024 * 150, 2));
      } catch {}
    }, 1200);

    globalQueue.addLog('INFO', `Created new song in library: "${songTitle}.flac" under "${artistName}"`);
    res.json({ success: true, path: songPath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Save or edit lyrics companion file
app.post('/api/library/save-lyrics', (req, res) => {
  const { filePath, lyrics } = req.body;
  if (!filePath || lyrics === undefined) {
    return res.status(400).json({ error: 'filePath and lyrics are required' });
  }

  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const lrcPath = path.join(dir, `${base}.lrc`);

  try {
    fs.writeFileSync(lrcPath, lyrics, 'utf-8');
    globalQueue.addLog('INFO', `Saved companion lyrics for "${base}" at ${lrcPath}`);
    res.json({ success: true, lrcPath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Lyric Providers metadata
app.get('/api/lyrics/providers', (req, res) => {
  res.json({
    providers: DEFAULT_PROVIDER_ORDER,
    displayNames: PROVIDER_DISPLAY_NAMES,
    activeOrder: getActiveProviderList(),
  });
});

// Direct multi-provider lyric search
app.post('/api/lyrics/search', async (req, res) => {
  const { title, artist, album, duration, provider, leadInMs, format } = req.body;
  if (!title || !artist) {
    return res.status(400).json({ error: 'Title and artist are required' });
  }

  try {
    const providers = provider ? [provider] : undefined;
    if (format === 'LRC') {
      const result = await fetchUnifiedLrc(title, artist, album, duration ? Number(duration) : undefined, {
        providers,
      });
      return res.json(result);
    } else {
      const result = await fetchUnifiedElrc(title, artist, album, duration ? Number(duration) : undefined, {
        leadInMs: leadInMs ? Number(leadInMs) : undefined,
        providers,
      });
      return res.json(result);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Audio stream preview endpoint
app.get('/api/audio', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).send('Audio file not found');
  }

  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.flac': 'audio/flac',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
  };

  res.writeHead(200, {
    'Content-Type': mimeMap[ext] || 'audio/octet-stream',
    'Content-Length': stat.size,
  });

  const readStream = fs.createReadStream(filePath);
  readStream.pipe(res);
});

// --------------------------------------------------------------------------
// VITE MIDDLEWARE & SERVER STARTUP
// --------------------------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const isPackaged = typeof (process as any).pkg !== 'undefined';
    const distPath = isPackaged
      ? path.join(path.dirname(process.execPath), 'dist')
      : path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Yimly Sync Monitor] Server running on http://0.0.0.0:${PORT}`);

    // Asynchronous non-blocking background startup tasks
    ensureSampleLibrary()
      .then(() => {
        const settings = getSettings();
        if (settings.autoStartMonitoring) {
          return globalMonitor.start();
        }
      })
      .catch((err) => {
        console.error('[Yimly Sync] Background initialization error:', err);
      });
  });
}

startServer().catch((err) => {
  console.error('Fatal startup error:', err);
});
