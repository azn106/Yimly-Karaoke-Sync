import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import { loadSettings, saveSettings, getSettings } from './server/config.js';
import { scanMediaDirectory, updateSingleSongInIndex } from './server/scanner.js';
import { globalQueue } from './server/queue.js';
import { globalMonitor } from './server/monitor.js';
import { runDiagnostics, runLiveGpuAudit } from './server/diagnostics.js';
import { ensureSampleLibrary } from './server/sampleData.js';
import { extractMetadata } from './server/metadata.js';
import { fetchUnifiedElrc, fetchUnifiedLrc, DEFAULT_PROVIDER_ORDER, PROVIDER_DISPLAY_NAMES, getActiveProviderList } from './server/lyrics/manager.js';
import {
  hasUsers,
  loadUsers,
  saveUsers,
  findUserByUsername,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  checkRateLimit,
  extractSessionToken,
  authenticateRequest,
  requireAuth,
  requireAdmin,
  UserRecord,
} from './server/auth.js';

import { cleanupStaleTempWorkspaces } from './server/executor.js';
import { demucsWorkerManager } from './server/demucs_worker.js';

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
// AUTHENTICATION API ROUTES
// --------------------------------------------------------------------------
app.get('/api/auth/status', (req, res) => {
  const needsSetup = !hasUsers();
  if (needsSetup) {
    return res.json({ needsSetup: true, authenticated: false });
  }

  const session = authenticateRequest(req);
  if (!session) {
    return res.json({ needsSetup: false, authenticated: false });
  }

  res.json({
    needsSetup: false,
    authenticated: true,
    user: {
      id: session.userId,
      username: session.username,
      role: session.role,
    },
  });
});

app.post('/api/auth/setup', async (req, res) => {
  if (hasUsers()) {
    return res.status(400).json({ error: 'First-run setup already completed. Please log in.' });
  }

  const { username, password } = req.body;
  if (!username || typeof username !== 'string' || username.trim().length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const passwordHash = await hashPassword(password);
    const newUser: UserRecord = {
      id: `usr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      username: username.trim(),
      passwordHash,
      role: 'ADMIN',
      createdAt: Date.now(),
    };

    saveUsers([newUser]);
    const session = createSession(newUser);

    res.setHeader(
      'Set-Cookie',
      `session_token=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
    );

    res.json({
      success: true,
      user: { id: newUser.id, username: newUser.username, role: newUser.role },
      sessionToken: session.id,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Setup failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many failed login attempts. Please try again in 15 minutes.' });
  }

  const { username, password } = req.body;
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = findUserByUsername(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const isValid = await verifyPassword(password, user.passwordHash);
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const session = createSession(user);

  res.setHeader(
    'Set-Cookie',
    `session_token=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
  );

  res.json({
    success: true,
    user: { id: user.id, username: user.username, role: user.role },
    sessionToken: session.id,
  });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = extractSessionToken(req);
  destroySession(token || undefined);

  res.setHeader('Set-Cookie', 'session_token=; Path=/; HttpOnly; Max-Age=0');
  res.json({ success: true });
});

app.get('/api/auth/users', requireAdmin, (req, res) => {
  const users = loadUsers().map(u => ({
    id: u.id,
    username: u.username,
    role: u.role,
    createdAt: u.createdAt,
  }));
  res.json({ users });
});

app.post('/api/auth/users', requireAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || typeof username !== 'string' || username.trim().length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const targetRole = role === 'ADMIN' ? 'ADMIN' : 'USER';
  if (findUserByUsername(username)) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  try {
    const passwordHash = await hashPassword(password);
    const newUser: UserRecord = {
      id: `usr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      username: username.trim(),
      passwordHash,
      role: targetRole,
      createdAt: Date.now(),
    };

    const users = loadUsers();
    users.push(newUser);
    saveUsers(users);

    res.json({
      success: true,
      user: { id: newUser.id, username: newUser.username, role: newUser.role, createdAt: newUser.createdAt },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------------------------
// API ROUTES
// --------------------------------------------------------------------------

// SSE Stream
app.get('/api/events', requireAuth, (req, res) => {
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
app.get('/api/status', requireAuth, async (req, res) => {
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
app.get('/api/songs', requireAuth, async (req, res) => {
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
app.get('/api/queue', requireAuth, (req, res) => {
  res.json({
    jobs: globalQueue.getJobs(),
    activeJob: globalQueue.getActiveJob(),
    activeJobs: globalQueue.getActiveJobs(),
    isPaused: globalQueue.isQueuePaused(),
    isMonitoring: globalQueue.isMonitorRunning(),
  });
});

// Engine Logs
app.get('/api/logs', requireAuth, (req, res) => {
  res.json({
    logs: globalQueue.getLogs(),
  });
});

// Settings
app.get('/api/settings', requireAuth, (req, res) => {
  res.json({
    settings: getSettings(),
  });
});

app.post('/api/settings', requireAdmin, async (req, res) => {
  const updated = saveSettings(req.body);
  globalQueue.addLog('INFO', `Settings updated. Media Root: ${updated.mediaRoot}, Model: ${updated.demucs.model}, GPU: ${updated.useGpu ? 'ON' : 'OFF'}`);
  
  // If media root changed, optionally rescan
  if (req.body.mediaRoot) {
    await globalMonitor.runStartupScan();
  }
  
  res.json({ success: true, settings: updated });
});

// Diagnostics
app.get('/api/diagnostics', requireAuth, async (req, res) => {
  const diag = await runDiagnostics();
  res.json(diag);
});

// Real GPU Workload Audit
app.get('/api/diagnostics/gpu-check', requireAuth, async (req, res) => {
  try {
    const gpuAudit = await runLiveGpuAudit();
    res.json(gpuAudit);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Monitor Controls (ADMIN ONLY)
app.post('/api/monitor/start', requireAdmin, async (req, res) => {
  await globalMonitor.start();
  res.json({ success: true, monitoring: true });
});

app.post('/api/monitor/stop', requireAdmin, (req, res) => {
  globalMonitor.stop();
  res.json({ success: true, monitoring: false });
});

app.post('/api/monitor/scan', requireAdmin, async (req, res) => {
  await globalMonitor.runStartupScan();
  const settings = getSettings();
  const scan = await scanMediaDirectory(settings.mediaRoot);
  res.json({ success: true, scan });
});

// Queue Controls
app.post('/api/queue/pause', requireAdmin, (req, res) => {
  globalQueue.setQueuePaused(true);
  res.json({ success: true, paused: true });
});

app.post('/api/queue/resume', requireAdmin, (req, res) => {
  globalQueue.setQueuePaused(false);
  res.json({ success: true, paused: false });
});

app.post('/api/queue/retry-failed', requireAdmin, (req, res) => {
  globalQueue.retryFailed();
  res.json({ success: true });
});

app.post('/api/queue/retry/:id', requireAdmin, (req, res) => {
  globalQueue.retryJob(req.params.id);
  res.json({ success: true });
});

app.post('/api/queue/clear-completed', requireAdmin, (req, res) => {
  globalQueue.clearCompleted();
  res.json({ success: true });
});

app.post('/api/queue/remove/:id', requireAdmin, (req, res) => {
  globalQueue.removeJob(req.params.id);
  res.json({ success: true });
});

app.post('/api/queue/enqueue', requireAuth, (req, res) => {
  const { filePath, artistName, force } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required' });
  }
  const job = globalQueue.enqueueSong(filePath, artistName || '', 'QUEUED', Boolean(force));
  res.json({ success: Boolean(job), job });
});

app.post('/api/queue/process-all-incomplete', requireAuth, async (req, res) => {
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

app.post('/api/validate-path', requireAdmin, (req, res) => {
  const { p, type } = req.body;
  if (!p || typeof p !== 'string') return res.json({ valid: false, error: 'No path provided' });

  let rawPath = p;
  try {
    rawPath = decodeURIComponent(p);
  } catch {}

  const settings = getSettings();
  const allowedRoots = [settings.mediaRoot, settings.modelsDir, settings.tempDir, process.cwd()];

  const isAllowed = allowedRoots.some(root => isPathAllowedInRoot(rawPath, root));
  if (!isAllowed) {
    return res.json({ valid: false, error: 'Access denied: path outside allowed directories' });
  }

  try {
    const realPath = fs.realpathSync(rawPath);
    const stats = fs.statSync(realPath);
    if (type === 'file' && !stats.isFile()) return res.json({ valid: false, error: 'Not a file' });
    if (type === 'folder' && !stats.isDirectory()) return res.json({ valid: false, error: 'Not a folder' });
    res.json({ valid: true });
  } catch (err: any) {
    res.json({ valid: false, error: err.message });
  }
});

// Helper: Add custom sample / new song to library for live copy detection simulation
app.post('/api/library/add-sample', requireAdmin, (req, res) => {
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
app.post('/api/library/save-lyrics', requireAdmin, async (req, res) => {
  const { filePath, lyrics } = req.body;
  if (!filePath || typeof filePath !== 'string' || lyrics === undefined) {
    return res.status(400).json({ error: 'filePath and lyrics are required' });
  }

  let rawPath = filePath;
  try {
    rawPath = decodeURIComponent(filePath);
  } catch {}

  const settings = getSettings();
  const mediaRoot = settings.mediaRoot;

  // Source audio file must be inside mediaRoot
  if (!isPathAllowedInRoot(rawPath, mediaRoot)) {
    return res.status(403).json({ error: 'Forbidden: File path is outside media root' });
  }

  const dir = path.dirname(rawPath);
  const base = path.basename(rawPath, path.extname(rawPath));
  const lrcPath = path.join(dir, `${base}.lrc`);

  // Target .lrc companion file must also be inside mediaRoot
  if (!isPathAllowedInRoot(lrcPath, mediaRoot)) {
    return res.status(403).json({ error: 'Forbidden: Target LRC path is outside media root' });
  }

  try {
    fs.writeFileSync(lrcPath, lyrics, 'utf-8');
    await updateSingleSongInIndex(rawPath, mediaRoot);
    globalQueue.addLog('INFO', `Saved companion lyrics for "${base}" at ${lrcPath}`);
    res.json({ success: true, lrcPath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Lyric Providers metadata
app.get('/api/lyrics/providers', requireAuth, (req, res) => {
  res.json({
    providers: DEFAULT_PROVIDER_ORDER,
    displayNames: PROVIDER_DISPLAY_NAMES,
    activeOrder: getActiveProviderList(),
  });
});

// Direct multi-provider lyric search
app.post('/api/lyrics/search', requireAuth, async (req, res) => {
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

export function isPathAllowedInRoot(targetPath: string, rootDir: string): boolean {
  try {
    if (!targetPath || !rootDir) return false;
    if (!fs.existsSync(rootDir)) return false;

    const realRoot = fs.realpathSync(rootDir);

    // Resolve non-existent path up to closest existing ancestor
    let current = path.resolve(targetPath);
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    if (!fs.existsSync(current)) return false;
    const realAncestor = fs.realpathSync(current);
    const rel = path.relative(realRoot, realAncestor);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return false;
    }

    // Also check normalized relative path from realRoot to resolved target
    const targetRel = path.relative(realRoot, path.resolve(targetPath));
    return !targetRel.startsWith('..') && !path.isAbsolute(targetRel);
  } catch {
    return false;
  }
}

export function isPathInsideDirectory(childPath: string, parentDir: string): boolean {
  try {
    if (!childPath || !parentDir) return false;
    if (!fs.existsSync(parentDir) || !fs.existsSync(childPath)) {
      return false;
    }
    const realParent = fs.realpathSync(parentDir);
    const realChild = fs.realpathSync(childPath);
    if (realParent === realChild) return false;
    const relative = path.relative(realParent, realChild);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

// Audio stream preview endpoint
app.get('/api/audio', requireAuth, (req, res) => {
  const rawPath = req.query.path;
  if (!rawPath || typeof rawPath !== 'string') {
    return res.status(404).send('Audio file not found');
  }

  let filePath = rawPath;
  try {
    filePath = decodeURIComponent(rawPath);
  } catch {}

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Audio file not found');
  }

  const settings = getSettings();
  if (!isPathInsideDirectory(filePath, settings.mediaRoot)) {
    return res.status(403).send('Forbidden');
  }

  try {
    const realPath = fs.realpathSync(filePath);
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
      return res.status(403).send('Forbidden');
    }

    const ext = path.extname(realPath).toLowerCase();
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

    const readStream = fs.createReadStream(realPath);
    readStream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).send('Error streaming audio file');
      }
    });
    readStream.pipe(res);
  } catch (err) {
    return res.status(404).send('Audio file not found');
  }
});

// --------------------------------------------------------------------------
// VITE MIDDLEWARE & SERVER STARTUP
// --------------------------------------------------------------------------
let isShuttingDown = false;
function setupGracefulShutdown(httpServer: any) {
  const handleShutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Yimly Sync] Received ${signal}. Starting graceful shutdown...`);

    const shutdownTimer = setTimeout(() => {
      console.warn('[Yimly Sync] Graceful shutdown timed out (5s limit). Forcing exit.');
      process.exit(1);
    }, 5000);

    try {
      globalMonitor.stop();
      globalQueue.shutdown();
      demucsWorkerManager.stopWorker();
      flushLogs();

      if (httpServer) {
        httpServer.close(() => {
          clearTimeout(shutdownTimer);
          console.log('[Yimly Sync] Graceful shutdown completed cleanly.');
          process.exit(0);
        });
      } else {
        clearTimeout(shutdownTimer);
        process.exit(0);
      }
    } catch (e) {
      console.error('[Yimly Sync] Error during shutdown:', e);
      clearTimeout(shutdownTimer);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

async function startServer() {
  const settings = getSettings();
  cleanupStaleTempWorkspaces(settings.tempDir);

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

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Yimly Sync Monitor] Server running on http://0.0.0.0:${PORT}`);

    // Asynchronous non-blocking background startup tasks
    ensureSampleLibrary()
      .then(() => {
        const s = getSettings();
        if (s.autoStartMonitoring) {
          return globalMonitor.start();
        }
      })
      .catch((err) => {
        console.error('[Yimly Sync] Background initialization error:', err);
      });
  });

  setupGracefulShutdown(server);
}

const isMainScript = !process.argv[1] || (
  process.argv[1].endsWith('server.ts') || 
  process.argv[1].endsWith('server.js') || 
  process.argv[1].endsWith('server.cjs')
);

if (isMainScript) {
  startServer().catch((err) => {
    console.error('Fatal startup error:', err);
  });
}
