import fs from 'fs';
import path from 'path';
import { SongItem } from '../src/types.js';
import { extractMetadata } from './metadata.js';

export const SUPPORTED_AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.opus']);

export function isInstrumentalFilename(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    lower.includes('(instrumental)') ||
    lower.includes('[instrumental]') ||
    lower.includes(' - instrumental') ||
    lower.includes(' instrumental.') ||
    lower.includes('_instrumental.') ||
    lower.includes('(instrumental version)') ||
    lower.includes('[instrumental version]')
  );
}

export function findExistingInstrumental(audioPath: string): string | null {
  const dir = path.dirname(audioPath);
  const ext = path.extname(audioPath);
  const base = path.basename(audioPath, ext);

  const testExts = Array.from(new Set([ext, '.mp3', '.flac', '.m4a', '.wav', '.ogg', '.opus']));
  const patterns = [
    `${base} (Instrumental)`,
    `${base} [Instrumental]`,
    `${base} - Instrumental`,
    `${base} Instrumental`,
    `${base}_instrumental`,
    `${base} (Instrumental Version)`,
    `${base} [Instrumental Version]`,
  ];

  for (const pattern of patterns) {
    for (const testExt of testExts) {
      const candidate = path.join(dir, `${pattern}${testExt}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  // Directory scan fallback for flexible naming
  try {
    const files = fs.readdirSync(dir);
    const baseLower = base.toLowerCase();
    for (const file of files) {
      const fileLower = file.toLowerCase();
      if (fileLower.startsWith(baseLower) && isInstrumentalFilename(fileLower)) {
        const full = path.join(dir, file);
        if (fs.statSync(full).isFile()) {
          return full;
        }
      }
    }
  } catch {}

  return null;
}

export function findExistingElrc(audioPath: string): string | null {
  const dir = path.dirname(audioPath);
  const ext = path.extname(audioPath);
  const base = path.basename(audioPath, ext);

  const candidate = path.join(dir, `${base}.elrc.lrc`);
  return fs.existsSync(candidate) ? candidate : null;
}

export function findExistingNormalLrc(audioPath: string): string | null {
  const dir = path.dirname(audioPath);
  const ext = path.extname(audioPath);
  const base = path.basename(audioPath, ext);

  const candidate = path.join(dir, `${base}.lrc`);
  return fs.existsSync(candidate) ? candidate : null;
}

export interface ScanResult {
  songs: SongItem[];
  total: number;
  complete: number;
  incomplete: number;
}

// In-flight and short-TTL scan cache
const scanCache = new Map<string, { time: number; result: ScanResult }>();
const inFlightScans = new Map<string, Promise<ScanResult>>();
const SCAN_CACHE_TTL_MS = 2500;

export function invalidateScanCache(mediaRoot?: string) {
  if (mediaRoot) {
    scanCache.delete(path.resolve(mediaRoot));
    inFlightScans.delete(path.resolve(mediaRoot));
  } else {
    scanCache.clear();
    inFlightScans.clear();
  }
}

export async function scanMediaDirectory(mediaRoot: string, force = false): Promise<ScanResult> {
  const resolvedRoot = path.resolve(mediaRoot);
  const now = Date.now();

  if (!force) {
    const cached = scanCache.get(resolvedRoot);
    if (cached && now - cached.time < SCAN_CACHE_TTL_MS) {
      return cached.result;
    }
  }

  const existingInFlight = inFlightScans.get(resolvedRoot);
  if (existingInFlight) {
    return existingInFlight;
  }

  const scanPromise = (async () => {
    try {
      const result = await doScanMediaDirectory(resolvedRoot);
      scanCache.set(resolvedRoot, { time: Date.now(), result });
      return result;
    } finally {
      inFlightScans.delete(resolvedRoot);
    }
  })();

  inFlightScans.set(resolvedRoot, scanPromise);
  return scanPromise;
}

async function doScanMediaDirectory(mediaRoot: string): Promise<ScanResult> {
  if (!fs.existsSync(mediaRoot)) {
    try {
      fs.mkdirSync(mediaRoot, { recursive: true });
    } catch (e) {
      console.error(`Failed to create media directory ${mediaRoot}:`, e);
      return { songs: [], total: 0, complete: 0, incomplete: 0 };
    }
  }

  const rawAudioFiles: string[] = [];

  function walk(currentDir: string) {
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          // Skip temp/hidden folders
          if (entry.name.startsWith('.') || entry.name === 'htdemucs' || entry.name === 'node_modules') {
            continue;
          }
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          // Filter supported audio formats
          if (SUPPORTED_AUDIO_EXTS.has(ext)) {
            // Ignore files that are instrumentals
            if (isInstrumentalFilename(entry.name)) {
              continue;
            }
            // Ignore temp vocals or intermediate outputs
            if (entry.name.endsWith('_vocals.wav') || entry.name.endsWith('_vocals.flac') || entry.name.startsWith('.')) {
              continue;
            }
            rawAudioFiles.push(fullPath);
          }
        }
      }
    } catch (err) {
      console.error(`Error walking directory ${currentDir}:`, err);
    }
  }

  walk(mediaRoot);

  let completeCount = 0;
  let incompleteCount = 0;

  // Process files in batches to prevent event-loop choking and bound concurrency
  const BATCH_SIZE = 8;
  const songItems: SongItem[] = [];

  for (let i = 0; i < rawAudioFiles.length; i += BATCH_SIZE) {
    const batch = rawAudioFiles.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (audioPath) => {
        const dir = path.dirname(audioPath);
        const fileName = path.basename(audioPath);
        const ext = path.extname(audioPath);
        const basename = path.basename(audioPath, ext);

        // Relative artist directory calculation
        const relFromRoot = path.relative(mediaRoot, dir);
        const artistName = relFromRoot && relFromRoot !== '.' ? relFromRoot.split(path.sep)[0] : path.basename(dir);

        // Completion and file checks
        const foundInstrumental = findExistingInstrumental(audioPath);
        const hasInstrumental = Boolean(foundInstrumental);
        const expectedInstrumental = path.join(dir, `${basename} (Instrumental)${ext}`);

        const foundElrc = findExistingElrc(audioPath);
        const hasElrc = Boolean(foundElrc);
        const expectedElrc = path.join(dir, `${basename}.elrc.lrc`);

        const foundNormalLrc = findExistingNormalLrc(audioPath);
        const hasNormalLrc = Boolean(foundNormalLrc);
        const normalLrc = path.join(dir, `${basename}.lrc`);

        const isComplete = hasElrc;

        let stats: fs.Stats | null = null;
        try {
          stats = fs.statSync(audioPath);
        } catch {}

        const metadata = await extractMetadata(audioPath, stats);

        return {
          item: {
            id: path.resolve(audioPath),
            filePath: audioPath,
            fileName,
            basename,
            ext,
            artistDir: dir,
            artistName: metadata.artist || artistName,
            sizeBytes: stats ? stats.size : 0,
            lastModified: stats ? stats.mtimeMs : Date.now(),
            hasInstrumental,
            instrumentalPath: foundInstrumental || expectedInstrumental,
            hasElrc,
            elrcPath: foundElrc || expectedElrc,
            hasNormalLrc,
            normalLrcPath: foundNormalLrc || normalLrc,
            isComplete,
            metadata,
          },
          isComplete,
        };
      })
    );

    for (const res of batchResults) {
      if (res.isComplete) {
        completeCount++;
      } else {
        incompleteCount++;
      }
      songItems.push(res.item);
    }
  }

  // Sort by artist name, then filename
  songItems.sort((a, b) => {
    const artistCmp = a.artistName.localeCompare(b.artistName);
    if (artistCmp !== 0) return artistCmp;
    return a.fileName.localeCompare(b.fileName);
  });

  return {
    songs: songItems,
    total: songItems.length,
    complete: completeCount,
    incomplete: incompleteCount,
  };
}

export function checkSongCompletion(audioPath: string): { isComplete: boolean; hasInstrumental: boolean; hasElrc: boolean; hasNormalLrc: boolean; instrumentalPath: string; elrcPath: string; normalLrcPath: string } {
  const dir = path.dirname(audioPath);
  const ext = path.extname(audioPath);
  const basename = path.basename(audioPath, ext);

  const foundInstrumental = findExistingInstrumental(audioPath);
  const foundElrc = findExistingElrc(audioPath);
  const foundNormalLrc = findExistingNormalLrc(audioPath);

  const instrumentalPath = foundInstrumental || path.join(dir, `${basename} (Instrumental)${ext}`);
  const elrcPath = foundElrc || path.join(dir, `${basename}.elrc.lrc`);
  const normalLrcPath = foundNormalLrc || path.join(dir, `${basename}.lrc`);

  return {
    isComplete: Boolean(foundElrc),
    hasInstrumental: Boolean(foundInstrumental),
    hasElrc: Boolean(foundElrc),
    hasNormalLrc: Boolean(foundNormalLrc),
    instrumentalPath,
    elrcPath,
    normalLrcPath,
  };
}
