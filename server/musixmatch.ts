import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getSettings } from './config.js';

const HMAC_SECRET = 'IEJ5E8XFaHQvIQNfs7IC';
const BASE_URL = 'https://apic-desktop.musixmatch.com/ws/1.1';
const APP_ID = 'web-desktop-app-v1.0';

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
const TOKEN_CACHE_FILE = path.join(process.cwd(), '.musixmatch_token');

function loadPersistedToken(): { token: string; expiresAt: number } | null {
  try {
    if (fs.existsSync(TOKEN_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf-8'));
      if (data.token && (data.expiresAt ? Date.now() < data.expiresAt : true)) {
        return data;
      }
    }
  } catch {}
  return null;
}

function savePersistedToken(token: string, expiresAt: number) {
  try {
    fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify({ token, expiresAt }), 'utf-8');
  } catch {}
}

export function clearPersistedToken(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
  try {
    if (fs.existsSync(TOKEN_CACHE_FILE)) {
      fs.unlinkSync(TOKEN_CACHE_FILE);
    }
  } catch {}
}

export interface RichsyncChunk {
  c?: string;
  o?: number;
}

export interface RichsyncLine {
  ts: number;
  te: number;
  l?: RichsyncChunk[];
  x?: string;
}

export interface TrackMatch {
  trackId: number;
  trackName: string;
  artistName: string;
  hasRichsync: boolean;
  hasSubtitles: boolean;
  duration?: number;
}

export function formatTimestamp(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = s.toFixed(2).padStart(5, '0');
  return `${mm}:${ss}`;
}

export function signRequest(url: string, params: Record<string, string | number | boolean | undefined>): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const fullParams: Record<string, string> = {};
  
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      fullParams[k] = String(v);
    }
  }
  fullParams['timestamp'] = String(timestamp);

  const sortedKeys = Object.keys(fullParams).sort();
  const queryStr = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(fullParams[k])}`)
    .join('&');
  const fullUrl = `${url}?${queryStr}`;

  const hmac = crypto.createHmac('sha256', HMAC_SECRET);
  hmac.update(fullUrl);
  const signature = hmac.digest('base64url');

  return `${fullUrl}&signature=${encodeURIComponent(signature)}&signature_protocol=sha256`;
}

export async function getMusixmatchToken(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh) {
    if (cachedToken && (tokenExpiresAt === 0 || now < tokenExpiresAt)) {
      return cachedToken;
    }
    const persisted = loadPersistedToken();
    if (persisted?.token) {
      cachedToken = persisted.token;
      tokenExpiresAt = persisted.expiresAt || 0;
      return cachedToken;
    }
  } else {
    clearPersistedToken();
  }

  // Check if token is in environment (only when not forceRefresh)
  const envToken = process.env.MUSIXMATCH_USER_TOKEN || process.env.MUSIXMATCH_TOKEN;
  if (envToken && !forceRefresh) {
    cachedToken = envToken.trim();
    tokenExpiresAt = now + 7 * 24 * 60 * 60 * 1000;
    savePersistedToken(cachedToken, tokenExpiresAt);
    return cachedToken;
  }

  const endpoint = `${BASE_URL}/token.get`;
  const guid = crypto.randomUUID();
  const signedUrl = signRequest(endpoint, {
    app_id: APP_ID,
    format: 'json',
    guid,
    lang: 'en',
  });

  const res = await fetch(signedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    if (!forceRefresh) {
      const persisted = loadPersistedToken();
      if (persisted?.token) {
        cachedToken = persisted.token;
        return cachedToken;
      }
    }
    throw new Error(`Token request HTTP status ${res.status}`);
  }

  const data = (await res.json()) as any;
  const body = data.message?.body;
  const token = body?.user_token;

  if (!token) {
    const hint = data.message?.header?.hint || 'unknown';
    if (!forceRefresh) {
      const persisted = loadPersistedToken();
      if (persisted?.token) {
        cachedToken = persisted.token;
        tokenExpiresAt = now + 12 * 60 * 60 * 1000;
        return cachedToken;
      }
    }
    throw new Error(`Failed to acquire Musixmatch token (hint: ${hint})`);
  }

  cachedToken = token;
  tokenExpiresAt = now + 24 * 60 * 60 * 1000;
  savePersistedToken(cachedToken, tokenExpiresAt);
  return token;
}

/**
 * Normalizes text for comparison:
 * - handles smart/curly quotes and apostrophes
 * - removes diacritics
 * - normalizes whitespace and punctuation
 */
export function normalizeText(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .replace(/[’‘ʻʼ`]/g, "'") // normalize apostrophes
    .replace(/[“”«»]/g, '"') // normalize quotes
    .replace(/[–—−‐]/g, '-') // normalize hyphens/dashes
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ') // remove other special chars
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strips secondary noise from titles (e.g. (feat. ...), [Remastered], etc.) for fallback matching
 */
export function cleanTitle(title: string): string {
  if (!title) return '';
  return title
    .replace(/\s*[\(\[](feat\.?|ft\.?|featuring|with|remastered|remaster|radio edit|original mix|deluxe|bonus track|official|audio|video|explicit|clean|anniversary|live|mono|stereo)[\s\S]*?[\)\]]/gi, '')
    .replace(/\s*-\s*(feat\.?|ft\.?|featuring|with|remastered|remaster|radio edit|original mix|deluxe|bonus track|official|audio|video|explicit|clean|anniversary|live|mono|stereo)[\s\S]*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strips secondary noise from artist names (e.g. feat. ... or trailing details)
 */
export function cleanArtist(artist: string): string {
  if (!artist) return '';
  return artist
    .replace(/\s*(feat\.?|ft\.?|featuring|with|vs\.?)\s+.*$/gi, '')
    .replace(/,.*$/, '')
    .replace(/&.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Performs signed Musixmatch API GET request with automatic token renewal handling
 */
async function apiGet(
  method: string,
  params: Record<string, string | number | boolean | undefined>,
  isRetry = false
): Promise<any> {
  const token = await getMusixmatchToken();
  const requestParams = {
    app_id: APP_ID,
    format: 'json',
    usertoken: token,
    ...params,
  };

  let signedUrl = signRequest(`${BASE_URL}/${method}`, requestParams);
  let res = await fetch(signedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    return { message: { header: { status_code: res.status } } };
  }

  let data = (await res.json()) as any;
  let header = data.message?.header;

  // Handle token invalidation on ANY 401 response (captcha, renew, expired credentials, etc.)
  if (header?.status_code === 401) {
    const hint = header?.hint || 'unknown';
    if (!isRetry) {
      console.log(`[DEBUG] Musixmatch returned 401 (hint=${hint}); invalidating cached token`);
      clearPersistedToken();
      console.log(`[DEBUG] Acquiring fresh Musixmatch token`);
      try {
        await getMusixmatchToken(true);
        console.log(`[DEBUG] Retrying request once with fresh token`);
        return await apiGet(method, params, true);
      } catch (err: any) {
        console.log(`[DEBUG] Failed to acquire fresh Musixmatch token: ${err.message}`);
        return data;
      }
    } else {
      console.log(`[DEBUG] Fresh-token retry also returned 401; giving up`);
    }
  }

  return data;
}

/**
 * Matches a track on Musixmatch using exact matcher.track.get (title + artist, no album, no duration)
 */
export async function matchTrack(
  title: string,
  artist: string,
  _album?: string,
  _duration?: number
): Promise<TrackMatch | null> {
  const trimmedTitle = title.trim();
  const trimmedArtist = artist.trim();

  if (!trimmedTitle || !trimmedArtist) {
    return null;
  }

  console.log(`[DEBUG] matcher.track title="${trimmedTitle}" artist="${trimmedArtist}"`);

  try {
    const data = await apiGet('matcher.track.get', {
      q_artist: trimmedArtist,
      q_track: trimmedTitle,
    });

    const header = data.message?.header;
    if (header?.status_code === 200 && data.message?.body?.track?.track_id) {
      const track = data.message.body.track;
      console.log(`[DEBUG] matcher.track returned track_id=${track.track_id}`);
      return {
        trackId: track.track_id,
        trackName: track.track_name || trimmedTitle,
        artistName: track.artist_name || trimmedArtist,
        hasRichsync: Boolean(track.has_richsync === 1 || track.has_richsync === true),
        hasSubtitles: Boolean(track.has_subtitles === 1 || track.has_subtitles === true),
        duration: track.track_length,
      };
    } else {
      console.log(`[DEBUG] matcher_track failed`);
    }
  } catch (err: any) {
    console.log(`[DEBUG] matcher_track failed: ${err.message}`);
  }

  return null;
}

export function renderRichsyncToElrc(lines: RichsyncLine[], leadInMs: number = 0): string | null {
  if (!Array.isArray(lines) || lines.length === 0) {
    return null;
  }

  const safeLeadInMs = Math.max(0, Math.min(5000, Number.isFinite(leadInMs) ? leadInMs : 0));
  const safeLeadInSec = safeLeadInMs / 1000;

  const outputLines: string[] = [];

  for (const line of lines) {
    const lineTs = Number(line.ts) || 0;

    const wordTokens: string[] = [];
    let firstWordTs: number | null = null;
    let currentWord = '';
    let currentWordOffset: number | null = null;

    if (Array.isArray(line.l) && line.l.length > 0) {
      for (let i = 0; i < line.l.length; i++) {
        const chunk = line.l[i];
        const text = chunk.c || '';
        const offset = Number(chunk.o) || 0;

        if (text.trim() === '') {
          // Whitespace separator between words
          if (currentWord) {
            const wordTs = lineTs + (currentWordOffset ?? 0);
            if (firstWordTs === null) {
              firstWordTs = wordTs;
            }
            wordTokens.push(`<${formatTimestamp(wordTs)}>${currentWord}`);
            currentWord = '';
            currentWordOffset = null;
          }
        } else {
          if (currentWordOffset === null) {
            currentWordOffset = offset;
          }
          currentWord += text;
        }
      }

      if (currentWord && currentWordOffset !== null) {
        const wordTs = lineTs + currentWordOffset;
        if (firstWordTs === null) {
          firstWordTs = wordTs;
        }
        wordTokens.push(`<${formatTimestamp(wordTs)}>${currentWord}`);
      }
    }

    // Determine outer line timestamp: exactly leadInMs before the first word timestamp, clamped to 00:00.00
    let outerLineTs: number;
    if (firstWordTs !== null) {
      outerLineTs = Math.max(0, Math.round((firstWordTs - safeLeadInSec) * 100) / 100);
    } else {
      outerLineTs = Math.max(0, Math.round((lineTs - safeLeadInSec) * 100) / 100);
    }
    const outerLineFormatted = formatTimestamp(outerLineTs);

    if (wordTokens.length > 0) {
      outputLines.push(`[${outerLineFormatted}] ${wordTokens.join(' ')}`);
    } else if (line.x && line.x.trim()) {
      const fallbackWordTs = lineTs;
      const fallbackOuterTs = Math.max(0, Math.round((fallbackWordTs - safeLeadInSec) * 100) / 100);
      outputLines.push(`[${formatTimestamp(fallbackOuterTs)}] <${formatTimestamp(fallbackWordTs)}>${line.x.trim()}`);
    } else {
      outputLines.push(`[${outerLineFormatted}]`);
    }
  }

  return outputLines.length > 0 ? outputLines.join('\n') : null;
}

/**
 * Retrieves Richsync for exact trackId and formats it to eLRC (no duration filtering)
 */
export async function fetchRichsync(trackId: number, leadInMs?: number): Promise<string | null> {
  console.log(`[DEBUG] track.richsync.get track_id=${trackId}`);

  try {
    const data = await apiGet('track.richsync.get', {
      track_id: String(trackId),
    });

    const header = data.message?.header;
    if (header?.status_code !== 200) {
      console.log(`[DEBUG] track_richsync failed`);
      return null;
    }

    let body = data.message?.body?.richsync?.richsync_body;
    if (!body) {
      console.log(`[DEBUG] track_richsync failed`);
      return null;
    }

    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        console.log(`[DEBUG] richsync line parse failed`);
        return null;
      }
    }

    const elrc = renderRichsyncToElrc(body, leadInMs);
    if (elrc) {
      console.log(`[DEBUG] Richsync returned successfully`);
      return elrc;
    } else {
      console.log(`[DEBUG] richsync line parse failed`);
      return null;
    }
  } catch (err: any) {
    console.log(`[DEBUG] track_richsync failed: ${err.message}`);
    return null;
  }
}

/**
 * Retrieves standard synchronized subtitle (.lrc) for a track using matcher.subtitle.get
 */
export async function fetchSubtitleLrc(
  title: string,
  artist: string
): Promise<string | null> {
  const trimmedTitle = title.trim();
  const trimmedArtist = artist.trim();

  if (!trimmedTitle || !trimmedArtist) {
    return null;
  }

  console.log(`[DEBUG] matcher.subtitle title="${trimmedTitle}" artist="${trimmedArtist}"`);

  try {
    const data = await apiGet('matcher.subtitle.get', {
      q_track: trimmedTitle,
      q_artist: trimmedArtist,
      subtitle_format: 'lrc',
    });

    const header = data.message?.header;
    if (header?.status_code !== 200) {
      console.log(`[DEBUG] matcher_subtitle failed`);
      return null;
    }

    const body = data.message?.body?.subtitle?.subtitle_body;
    if (body && typeof body === 'string') {
      const trimmed = body.trim();
      if (trimmed.includes('[') && trimmed.includes(']')) {
        console.log(`[DEBUG] Standard subtitle returned successfully`);
        return trimmed;
      }
    }

    console.log(`[DEBUG] matcher_subtitle failed`);
    return null;
  } catch (err: any) {
    console.log(`[DEBUG] matcher_subtitle failed: ${err.message}`);
    return null;
  }
}

/**
 * Independent eLRC Fetcher: Searches Musixmatch (matcher.track.get) -> exact track_id -> track.richsync.get -> formatted .elrc.lrc
 */
export async function fetchElrc(
  title: string,
  artist: string,
  album?: string,
  duration?: number,
  leadInMs?: number
): Promise<{ success: boolean; elrc?: string; error?: string }> {
  try {
    const track = await matchTrack(title, artist, album, duration);
    if (!track) {
      return { success: false, error: 'Track not found on Musixmatch' };
    }

    const elrc = await fetchRichsync(track.trackId, leadInMs);
    if (!elrc) {
      return { success: false, error: 'Richsync not available for this track' };
    }

    return { success: true, elrc };
  } catch (err: any) {
    return { success: false, error: err.message || 'Unknown Richsync error' };
  }
}

/**
 * Independent LRC Fetcher: Calls matcher.subtitle.get with title + artist -> .lrc
 */
export async function fetchLrc(
  title: string,
  artist: string,
  _album?: string,
  _duration?: number
): Promise<{ success: boolean; lrc?: string; error?: string }> {
  try {
    const lrc = await fetchSubtitleLrc(title, artist);
    if (!lrc) {
      return { success: false, error: 'Standard LRC subtitle not available on Musixmatch' };
    }

    return { success: true, lrc };
  } catch (err: any) {
    return { success: false, error: err.message || 'Unknown Subtitle LRC error' };
  }
}

