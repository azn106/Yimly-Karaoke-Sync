import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { SongMetadata } from '../src/types.js';
import { getSettings } from './config.js';

// Cache to prevent re-extracting metadata for unchanged files
const metadataCache = new Map<string, { mtime: number; size: number; metadata: SongMetadata }>();
const inFlightProbes = new Map<string, Promise<SongMetadata>>();

// Instrumentation metrics
let ffprobeInvocationCount = 0;
let metadataCacheHits = 0;
let metadataCacheMisses = 0;
let inFlightDeduplications = 0;

export function getMetadataMetrics() {
  return {
    ffprobeInvocationCount,
    metadataCacheHits,
    metadataCacheMisses,
    inFlightDeduplications,
    cacheSize: metadataCache.size,
  };
}

export function resetMetadataMetrics() {
  ffprobeInvocationCount = 0;
  metadataCacheHits = 0;
  metadataCacheMisses = 0;
  inFlightDeduplications = 0;
}

export function invalidateMetadataCache(audioPath?: string) {
  if (audioPath) {
    const resolved = path.resolve(audioPath);
    metadataCache.delete(resolved);
    inFlightProbes.delete(resolved);
  } else {
    metadataCache.clear();
    inFlightProbes.clear();
  }
}

export function setCachedMetadata(
  audioPath: string,
  metadata: SongMetadata,
  stats?: { mtimeMs?: number; size?: number }
) {
  const resolved = path.resolve(audioPath);
  let mtime = stats?.mtimeMs ?? 0;
  let size = stats?.size ?? 0;
  if ((!mtime || !size) && fs.existsSync(resolved)) {
    try {
      const st = fs.statSync(resolved);
      mtime = st.mtimeMs;
      size = st.size;
    } catch {}
  }
  metadataCache.set(resolved, {
    mtime,
    size,
    metadata,
  });
}

// Simple concurrency limiter for ffprobe processes
let activeFfprobeCount = 0;
const MAX_CONCURRENT_FFPROBE = 4;
const ffprobeQueue: Array<() => void> = [];

function acquireFfprobeSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const startTask = () => {
      activeFfprobeCount++;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          activeFfprobeCount--;
          if (ffprobeQueue.length > 0) {
            const next = ffprobeQueue.shift();
            if (next) next();
          }
        }
      };
      resolve(release);
    };

    if (activeFfprobeCount < MAX_CONCURRENT_FFPROBE) {
      startTask();
    } else {
      ffprobeQueue.push(startTask);
    }
  });
}

export async function extractMetadata(audioPath: string, stats?: fs.Stats | null): Promise<SongMetadata> {
  const resolvedPath = path.resolve(audioPath);

  let fileStats = stats;
  if (!fileStats) {
    try {
      fileStats = fs.statSync(resolvedPath);
    } catch {
      return getFallbackMetadata(resolvedPath);
    }
  }

  // 1. Check in-memory metadata cache (path + mtime + size validation)
  const cached = metadataCache.get(resolvedPath);
  if (cached && fileStats && cached.mtime === fileStats.mtimeMs && cached.size === fileStats.size) {
    metadataCacheHits++;
    return cached.metadata;
  }

  // 2. Check for an in-flight probe for the exact same file to avoid duplicate processes
  const existingInFlight = inFlightProbes.get(resolvedPath);
  if (existingInFlight) {
    inFlightDeduplications++;
    return existingInFlight;
  }

  // 3. Cache miss: trigger single ffprobe process
  metadataCacheMisses++;

  const probePromise = (async () => {
    try {
      ffprobeInvocationCount++;
      const release = await acquireFfprobeSlot();
      try {
        const metadata = await runFfprobeProcess(resolvedPath);
        if (fileStats) {
          metadataCache.set(resolvedPath, {
            mtime: fileStats.mtimeMs,
            size: fileStats.size,
            metadata,
          });
        }
        return metadata;
      } finally {
        release();
      }
    } finally {
      inFlightProbes.delete(resolvedPath);
    }
  })();

  inFlightProbes.set(resolvedPath, probePromise);
  return probePromise;
}

function runFfprobeProcess(resolvedPath: string): Promise<SongMetadata> {
  return new Promise<SongMetadata>((resolve) => {
    const ffprobePath = 'ffprobe';
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      resolvedPath,
    ];

    let stdout = '';
    let settled = false;

    const child = spawn(ffprobePath, args);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill('SIGKILL'); } catch {}
        resolve(getFallbackMetadata(resolvedPath));
      }
    }, 5000);

    child.stdout.on('data', (d) => { stdout += d.toString(); });

    child.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(getFallbackMetadata(resolvedPath));
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0 || !stdout.trim()) {
        resolve(getFallbackMetadata(resolvedPath));
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const tags = data.format?.tags || {};

        // Find if artwork stream exists
        const videoStreams = data.streams?.filter((s: any) => s.codec_type === 'video' || s.disposition?.attached_pic === 1);
        const hasArtwork = Boolean(videoStreams && videoStreams.length > 0);

        const title = tags.title || tags.TITLE || tags.Title || path.basename(resolvedPath, path.extname(resolvedPath));
        const artist = tags.artist || tags.ARTIST || tags.Artist || tags.album_artist || tags.ALBUM_ARTIST || '';
        const album = tags.album || tags.ALBUM || tags.Album || '';
        const albumArtist = tags.album_artist || tags.ALBUM_ARTIST || tags.albumartist || '';
        const genre = tags.genre || tags.GENRE || tags.GENRE || tags.Genre || '';
        const track = tags.track || tags.TRACK || tags.tracknumber || '';
        const disc = tags.disc || tags.DISC || tags.discnumber || '';
        const date = tags.date || tags.DATE || tags.year || tags.YEAR || '';
        const composer = tags.composer || tags.COMPOSER || '';
        const copyright = tags.copyright || tags.COPYRIGHT || '';

        // Check for embedded lyrics
        const embeddedLyrics = tags.lyrics || tags.LYRICS || tags.unsyncedlyrics || tags.UNSYNCEDLYRICS || tags.comment || '';

        // Check companion .lrc or .txt
        const dir = path.dirname(resolvedPath);
        const base = path.basename(resolvedPath, path.extname(resolvedPath));
        const lrcPath = path.join(dir, `${base}.lrc`);
        const txtPath = path.join(dir, `${base}.txt`);

        let lyricsSource: SongMetadata['lyricsSource'] = 'none';
        let lyricsPreview: string | undefined = undefined;

        if (embeddedLyrics && embeddedLyrics.trim().length > 10) {
          lyricsSource = 'embedded';
          lyricsPreview = embeddedLyrics.trim().slice(0, 120);
        } else if (fs.existsSync(lrcPath)) {
          lyricsSource = 'companion_lrc';
          try {
            const content = fs.readFileSync(lrcPath, 'utf-8');
            lyricsPreview = content.slice(0, 120);
          } catch {}
        } else if (fs.existsSync(txtPath)) {
          lyricsSource = 'companion_txt';
          try {
            const content = fs.readFileSync(txtPath, 'utf-8');
            lyricsPreview = content.slice(0, 120);
          } catch {}
        }

        const durationSec = data.format?.duration ? parseFloat(data.format.duration) : undefined;

        resolve({
          title,
          artist,
          album,
          albumArtist,
          genre,
          track,
          disc,
          date,
          composer,
          copyright,
          duration: durationSec && !isNaN(durationSec) ? durationSec : undefined,
          hasArtwork,
          hasEmbeddedLyrics: Boolean(embeddedLyrics && embeddedLyrics.trim().length > 10),
          embeddedLyrics: embeddedLyrics ? embeddedLyrics.trim() : undefined,
          lyricsSource,
          lyricsPreview,
        });
      } catch (e) {
        resolve(getFallbackMetadata(resolvedPath));
      }
    });
  });
}

const SUPPORTED_AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.opus', '.aac']);

/**
 * Searches for an existing matching instrumental file:
 * `Song Instrumental.mp3`, `Song (Instrumental).mp3`, `Song [Instrumental].mp3`, `Song - Instrumental.mp3`, `Song_Instrumental.mp3`, etc.
 */
export function findExistingInstrumental(audioPath: string): string | null {
  const dir = path.dirname(audioPath);
  const ext = path.extname(audioPath);
  const basename = path.basename(audioPath, ext);

  if (!fs.existsSync(dir)) return null;

  // 1. Direct candidate paths matching original extension
  const standardCandidates = [
    path.join(dir, `${basename} (Instrumental)${ext}`),
    path.join(dir, `${basename} Instrumental${ext}`),
    path.join(dir, `${basename} [Instrumental]${ext}`),
    path.join(dir, `${basename} - Instrumental${ext}`),
    path.join(dir, `${basename}_Instrumental${ext}`),
    path.join(dir, `${basename} (instrumental)${ext}`),
    path.join(dir, `${basename} instrumental${ext}`),
  ];

  for (const cand of standardCandidates) {
    if (fs.existsSync(cand)) {
      return cand;
    }
  }

  // 2. Directory scan for any audio extension with instrumental variation
  try {
    const files = fs.readdirSync(dir);
    const baseLower = basename.toLowerCase();

    for (const f of files) {
      const fExt = path.extname(f).toLowerCase();
      if (!SUPPORTED_AUDIO_EXTS.has(fExt)) continue;

      const fBase = path.basename(f, fExt);
      const fBaseLower = fBase.toLowerCase();

      // Check if file corresponds to the song and contains instrumental designation
      if (fBaseLower.startsWith(baseLower)) {
        const remaining = fBaseLower.slice(baseLower.length).trim();
        if (
          remaining === '(instrumental)' ||
          remaining === 'instrumental' ||
          remaining === '[instrumental]' ||
          remaining === '- instrumental' ||
          remaining === '_instrumental' ||
          remaining === '(inst)' ||
          remaining === '[inst]' ||
          remaining === '- inst' ||
          remaining === '_inst'
        ) {
          return path.join(dir, f);
        }
      }
    }
  } catch {}

  return null;
}

/**
 * Locates existing .elrc.lrc file (Musixmatch Richsync word-synced format)
 */
export function findExistingElrc(audioPath: string): string | null {
  const dir = path.dirname(audioPath);
  const ext = path.extname(audioPath);
  const basename = path.basename(audioPath, ext);

  const elrcPath = path.join(dir, `${basename}.elrc.lrc`);
  if (fs.existsSync(elrcPath)) {
    try {
      const stat = fs.statSync(elrcPath);
      if (stat.isFile() && stat.size > 0) return elrcPath;
    } catch {}
  }
  return null;
}

/**
 * Locates existing .lrc file (standard line-synced format, strictly NOT .elrc.lrc)
 */
export function findExistingLrc(audioPath: string): string | null {
  const dir = path.dirname(audioPath);
  const ext = path.extname(audioPath);
  const basename = path.basename(audioPath, ext);

  const lrcPath = path.join(dir, `${basename}.lrc`);
  if (fs.existsSync(lrcPath)) {
    try {
      const stat = fs.statSync(lrcPath);
      if (stat.isFile() && stat.size > 0) return lrcPath;
    } catch {}
  }
  return null;
}

function getFallbackMetadata(audioPath: string): SongMetadata {
  const base = path.basename(audioPath, path.extname(audioPath));
  const dir = path.dirname(audioPath);
  const lrcPath = path.join(dir, `${base}.lrc`);
  const txtPath = path.join(dir, `${base}.txt`);

  let lyricsSource: SongMetadata['lyricsSource'] = 'none';
  let lyricsPreview: string | undefined = undefined;

  if (fs.existsSync(lrcPath)) {
    lyricsSource = 'companion_lrc';
    try {
      lyricsPreview = fs.readFileSync(lrcPath, 'utf-8').slice(0, 120);
    } catch {}
  } else if (fs.existsSync(txtPath)) {
    lyricsSource = 'companion_txt';
    try {
      lyricsPreview = fs.readFileSync(txtPath, 'utf-8').slice(0, 120);
    } catch {}
  }

  return {
    title: base,
    artist: path.basename(dir),
    lyricsSource,
    lyricsPreview,
  };
}

export function findLyricsForAudio(audioPath: string, metadata: SongMetadata): string | null {
  const dir = path.dirname(audioPath);
  const base = path.basename(audioPath, path.extname(audioPath));
  
  // 1. Embedded lyrics from tags if present
  if (metadata.embeddedLyrics && metadata.embeddedLyrics.trim().length > 10) {
    return metadata.embeddedLyrics.trim();
  }

  // 2. Companion .lrc
  const lrcPath = path.join(dir, `${base}.lrc`);
  if (fs.existsSync(lrcPath)) {
    try {
      const content = fs.readFileSync(lrcPath, 'utf-8');
      if (content.trim()) return content.trim();
    } catch {}
  }

  // 3. Companion .txt
  const txtPath = path.join(dir, `${base}.txt`);
  if (fs.existsSync(txtPath)) {
    try {
      const content = fs.readFileSync(txtPath, 'utf-8');
      if (content.trim()) return content.trim();
    } catch {}
  }

  // Fallback to preview if available
  if (metadata.lyricsPreview && metadata.lyricsPreview.trim()) {
    return metadata.lyricsPreview.trim();
  }

  return null;
}

/**
 * Creates the final instrumental audio file using FFmpeg:
 * - Inherits all metadata, changing title to "<Original Title> (Instrumental)"
 * - Preserves artwork
 * - Removes embedded lyrics
 * - Converts isolated stem to the target format/extension matching original
 */
export async function createInstrumentalWithFFmpeg(
  originalAudioPath: string,
  isolatedStemPath: string,
  outputPath: string,
  metadata: SongMetadata,
  onLog: (msg: string) => void
): Promise<void> {
  const settings = getSettings();
  const ffmpegPath = settings.ffmpegPath || 'ffmpeg';

  return new Promise((resolve, reject) => {
    const ext = path.extname(originalAudioPath).toLowerCase();
    const instrumentalTitle = metadata.title ? `${metadata.title} (Instrumental)` : `${path.basename(originalAudioPath, ext)} (Instrumental)`;
    const tempOutputPath = `${outputPath}.tmp.${Date.now()}_${Math.random().toString(36).substring(2, 7)}${ext}`;

    onLog(`[INFO] Building instrumental: "${path.basename(outputPath)}" with title "${instrumentalTitle}"`);

    // FFmpeg args to mux the isolated audio with metadata and artwork from original
    const args = [
      '-y',
      '-i', isolatedStemPath,      // Input 0: Stem audio
      '-i', originalAudioPath,     // Input 1: Original file (for artwork & metadata)
      '-map', '0:a:0',             // Map audio from stem
    ];

    // If original has artwork, map video stream 0:v (attached pic)
    if (metadata.hasArtwork) {
      args.push('-map', '1:v:0?');
      args.push('-c:v', 'copy');
      args.push('-disposition:v:0', 'attached_pic');
    }

    // Set audio codec based on original format
    if (ext === '.flac') {
      args.push('-c:a', 'flac');
    } else if (ext === '.mp3') {
      args.push('-c:a', 'libmp3lame', '-b:a', `${settings.demucs.mp3Bitrate || 320}k`);
    } else if (ext === '.m4a' || ext === '.aac') {
      args.push('-c:a', 'aac', '-b:a', '256k');
    } else if (ext === '.ogg') {
      args.push('-c:a', 'libvorbis', '-q:a', '7');
    } else if (ext === '.wav') {
      args.push('-c:a', 'pcm_s16le');
    } else {
      args.push('-c:a', 'copy');
    }

    // Pass metadata
    args.push(
      '-metadata', `title=${instrumentalTitle}`,
      '-metadata', `artist=${metadata.artist || ''}`,
      '-metadata', `album=${metadata.album || ''}`,
      '-metadata', `album_artist=${metadata.albumArtist || ''}`,
      '-metadata', `genre=${metadata.genre || ''}`,
      '-metadata', `track=${metadata.track || ''}`,
      '-metadata', `disc=${metadata.disc || ''}`,
      '-metadata', `date=${metadata.date || ''}`,
      '-metadata', `composer=${metadata.composer || ''}`,
      '-metadata', `copyright=${metadata.copyright || ''}`,
      // Strip embedded lyrics
      '-metadata', 'lyrics=',
      '-metadata', 'LYRICS=',
      '-metadata', 'unsyncedlyrics=',
      '-metadata', 'UNSYNCEDLYRICS=',
      '-metadata', 'comment='
    );

    args.push(tempOutputPath);

    onLog(`[INFO] Executing FFmpeg command for instrumental encoding...`);

    const child = spawn(ffmpegPath, args);
    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      try { if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath); } catch {}
      reject(new Error(`Failed to launch FFmpeg: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(tempOutputPath)) {
        try {
          const stats = fs.statSync(tempOutputPath);
          if (stats.size > 0) {
            fs.renameSync(tempOutputPath, outputPath);
            onLog(`[INFO] Instrumental created successfully at ${outputPath}`);
            resolve();
            return;
          }
        } catch {}
      }

      try { if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath); } catch {}

      // Fallback simple copy/convert if muxing failed
      onLog(`[WARN] FFmpeg mux returned code ${code}, trying fallback conversion...`);
      fallbackSimpleConvert(ffmpegPath, isolatedStemPath, outputPath, instrumentalTitle, metadata, resolve, reject, onLog);
    });
  });
}

function fallbackSimpleConvert(
  ffmpegPath: string,
  stemPath: string,
  outputPath: string,
  title: string,
  metadata: SongMetadata,
  resolve: () => void,
  reject: (err: Error) => void,
  onLog: (msg: string) => void
) {
  const ext = path.extname(outputPath).toLowerCase();
  const tempOutputPath = `${outputPath}.fallback.tmp.${Date.now()}_${Math.random().toString(36).substring(2, 7)}${ext}`;

  const args = [
    '-y',
    '-i', stemPath,
    '-metadata', `title=${title}`,
    '-metadata', `artist=${metadata.artist || ''}`,
    tempOutputPath,
  ];

  const child = spawn(ffmpegPath, args);
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  child.on('close', (code) => {
    if (code === 0 && fs.existsSync(tempOutputPath)) {
      try {
        const stats = fs.statSync(tempOutputPath);
        if (stats.size > 0) {
          fs.renameSync(tempOutputPath, outputPath);
          onLog(`[INFO] Fallback instrumental conversion succeeded.`);
          resolve();
          return;
        }
      } catch {}
    }

    try { if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath); } catch {}
    const errDetail = stderr.split('\n').filter(l => l.trim().length > 0).slice(-3).join('; ');
    reject(new Error(`FFmpeg instrumental encoding failed with exit code ${code}${errDetail ? `: ${errDetail}` : ''}`));
  });

  child.on('error', (err) => {
    try { if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath); } catch {}
    reject(err);
  });
}
