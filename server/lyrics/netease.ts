import crypto from 'crypto';
import {
  RawLyricLine,
  RawLyricResult,
  RawLyricWord,
  calculateMatchScore,
  renderRawLinesToElrc,
  renderRawLinesToLrc,
  FetchLyricOptions,
  MIN_MATCH_SCORE,
  isValidFineGrainedPayload,
} from './types.js';

const EAPI_KEY = Buffer.from('e82ckenh8dichen8', 'utf8');

const DEVICE_IDS = [
  'AA9955F5FE37BA7EAF48F8EF0C9966B28293CC8D6415CCD93549',
  '4E4C19859A30F966B0D5B0F778FF62C4E040523CBA92FE9898E0',
  'DA2748C6B386C789255E9F8E18B1AE923E6BD5662BD71B7C602F',
  '74783EEE7DE080C2E03013443455449BF921543FF4D988F0',
  'AC40CFEE74679F0835E14A4558AEDD24E3DB919A5366C21432C1',
  '2FEC4E6687130AB09826D74CCEBEEB23A35C996E22515379EEA4',
];

function getRandomDeviceId(): string {
  return DEVICE_IDS[Math.floor(Math.random() * DEVICE_IDS.length)];
}

function aesEncrypt(data: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function aesDecrypt(data: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function eapiEncrypt(pathStr: string, params: any): string {
  const paramsJson = JSON.stringify(params);
  const pathBuf = Buffer.from(pathStr, 'utf8');
  const paramsBuf = Buffer.from(paramsJson, 'utf8');
  const signSrc = Buffer.concat([
    Buffer.from('nobody', 'utf8'),
    pathBuf,
    Buffer.from('use', 'utf8'),
    paramsBuf,
    Buffer.from('md5forencrypt', 'utf8'),
  ]);
  const sign = crypto.createHash('md5').update(signSrc).digest('hex');
  const aesSrc = Buffer.concat([
    pathBuf,
    Buffer.from('-36cd479b6b5-', 'utf8'),
    paramsBuf,
    Buffer.from('-36cd479b6b5-', 'utf8'),
    Buffer.from(sign, 'utf8'),
  ]);
  const encrypted = aesEncrypt(aesSrc, EAPI_KEY);
  return 'params=' + encrypted.toString('hex').toUpperCase();
}

export function eapiDecrypt(cipherBuf: Buffer): any {
  if (!cipherBuf || cipherBuf.length === 0) return null;
  // If response is already plaintext JSON (e.g. starts with '{' or '[')
  const firstChar = cipherBuf[0];
  if (firstChar === 0x7b /* '{' */ || firstChar === 0x5b /* '[' */) {
    try {
      return JSON.parse(cipherBuf.toString('utf8'));
    } catch {
      // continue to decrypt attempt
    }
  }
  try {
    const decrypted = aesDecrypt(cipherBuf, EAPI_KEY);
    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    try {
      return JSON.parse(cipherBuf.toString('utf8'));
    } catch {
      return null;
    }
  }
}

/**
 * Parses NetEase YRC raw format into structured RawLyricLine[]
 * Format:
 * [lineStart, lineDuration](wordStart, wordDuration, flag)word ...
 */
export function parseYrc(yrcText: string): RawLyricLine[] {
  if (!yrcText || typeof yrcText !== 'string') return [];

  const rawLines = yrcText.split('\n');
  const parsedLines: RawLyricLine[] = [];

  const lineRegex = /^\[(\d+),(\d+)\](.*)$/;
  const wordRegex = /\((\d+),(\d+),\d+\)([^(]*)/g;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Skip metadata JSON lines such as {"t":0,"c":[{"tx":"作词: "}]}
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      continue;
    }

    const match = trimmed.match(lineRegex);
    if (!match) continue;

    const lineStartMs = parseInt(match[1], 10);
    const lineDurationMs = parseInt(match[2], 10);
    const content = match[3];

    const words: RawLyricWord[] = [];
    let wMatch: RegExpExecArray | null;
    wordRegex.lastIndex = 0;

    while ((wMatch = wordRegex.exec(content)) !== null) {
      const wStartMs = parseInt(wMatch[1], 10);
      const wDurMs = parseInt(wMatch[2], 10);
      const wText = wMatch[3];
      if (wText) {
        words.push({
          startMs: wStartMs,
          durationMs: wDurMs,
          text: wText,
        });
      }
    }

    const lineText = words.map(w => w.text).join('').trim() || content.trim();

    parsedLines.push({
      startMs: lineStartMs,
      durationMs: lineDurationMs,
      words,
      text: lineText,
    });
  }

  return parsedLines;
}

export function formatNeteaseLrc(raw: string): string {
  if (!raw) return '';
  const lines = raw.split('\n');
  const res: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('{') && trimmed.includes('"t":')) {
      try {
        const obj = JSON.parse(trimmed);
        const tMs = typeof obj.t === 'number' ? obj.t : 0;
        const text = (obj.c || []).map((x: any) => x.tx || '').join('');
        const min = Math.floor(tMs / 60000);
        const sec = ((tMs % 60000) / 1000).toFixed(2);
        res.push(`[${String(min).padStart(2, '0')}:${sec.padStart(5, '0')}]${text}`);
        continue;
      } catch {}
    }

    // Standard LRC line or plain metadata
    res.push(trimmed);
  }

  return res.join('\n');
}

/**
 * Search NetEase for matching songs and retrieve word-synced YRC lyrics
 */
export async function fetchNeteaseLyrics(
  title: string,
  artist: string,
  options?: FetchLyricOptions
): Promise<RawLyricResult> {
  const log = options?.onLog || (() => {});
  const deviceId = getRandomDeviceId();

  const header = JSON.stringify({
    os: 'pc',
    appver: '3.1.3.203419',
    deviceId,
    requestId: 0,
    osver: 'Microsoft-Windows-10--build-22000-64bit',
  });

  // Sanitize query by removing raw semicolons and extra noise
  const sanitizedArtist = artist.replace(/;/g, ' ').replace(/\s+/g, ' ').trim();
  const sanitizedTitle = title.replace(/\s*[\(\[](?:feat\.?|ft\.?|featuring|with)[\s\S]*?[\)\]]/gi, '').trim();
  const query = `${sanitizedArtist} ${sanitizedTitle}`.trim() || `${artist} ${title}`.trim();
  log(`[NetEase] Searching for "${query}" (EAPI)...`);

  const searchParams = {
    keyword: query,
    scene: 'NORMAL',
    needCorrect: 'true',
    limit: '8',
    offset: '0',
    e_r: true,
    header,
  };

  try {
    const searchBody = eapiEncrypt('/api/search/song/list/page', searchParams);
    const searchRes = await fetch('https://interface.music.163.com/eapi/search/song/list/page', {
      method: 'POST',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.3.203419',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `os=pc; deviceId=${deviceId}; appver=3.1.3.203419`,
      },
      body: searchBody,
      signal: AbortSignal.timeout(8000),
    });

    if (!searchRes.ok) {
      return {
        success: false,
        source: 'netease',
        format: 'YRC',
        error: `NetEase search HTTP error: ${searchRes.status}`,
      };
    }

    const searchBuf = Buffer.from(await searchRes.arrayBuffer());
    const searchData = eapiDecrypt(searchBuf);

    const resources = searchData?.data?.resources || [];
    if (resources.length === 0) {
      log(`[NetEase] No songs found matching "${query}".`);
      return {
        success: false,
        source: 'netease',
        format: 'YRC',
        error: 'No matching tracks found on NetEase',
      };
    }

    // Rank candidates
    interface Candidate {
      id: number;
      name: string;
      artists: string;
      durationSec: number;
      score: number;
      reason: string;
    }

    const candidates: Candidate[] = [];

    for (const res of resources) {
      const song = res?.baseInfo?.simpleSongData;
      if (!song || !song.id) continue;

      const songTitle = song.name || '';
      const songArtists = Array.isArray(song.ar)
        ? song.ar.map((a: any) => a.name).join(', ')
        : '';
      const durationSec = (song.dt || 0) / 1000;

      const match = calculateMatchScore(
        title,
        artist,
        songTitle,
        songArtists,
        options?.duration,
        durationSec
      );

      if (match.durationPassed && match.isValid && match.score >= MIN_MATCH_SCORE) {
        candidates.push({
          id: song.id,
          name: songTitle,
          artists: songArtists,
          durationSec,
          score: match.score,
          reason: match.reason,
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      log(`[NetEase] Found ${resources.length} results, but none satisfied duration/metadata thresholds.`);
      return {
        success: false,
        source: 'netease',
        format: 'YRC',
        error: 'No candidate satisfied duration tolerance and metadata score',
      };
    }

    // Try up to top 3 candidates for YRC
    for (let i = 0; i < Math.min(3, candidates.length); i++) {
      const cand = candidates[i];
      log(`[NetEase] Querying lyrics for candidate #${i + 1}: "${cand.name}" by "${cand.artists}" (ID: ${cand.id}, score: ${cand.score})...`);

      const lyricParams = {
        id: cand.id,
        lv: -1,
        tv: -1,
        rv: -1,
        yv: -1,
        e_r: true,
        header,
      };

      const lyricBody = eapiEncrypt('/api/song/lyric/v1', lyricParams);
      const lyricRes = await fetch('https://interface.music.163.com/eapi/song/lyric/v1', {
        method: 'POST',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.3.203419',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': `os=pc; deviceId=${deviceId}; appver=3.1.3.203419`,
        },
        body: lyricBody,
        signal: AbortSignal.timeout(8000),
      });

      if (!lyricRes.ok) continue;

      const lyricBuf = Buffer.from(await lyricRes.arrayBuffer());
      const lyricData = eapiDecrypt(lyricBuf);

      const rawYrc = lyricData?.yrc?.lyric;
      if (rawYrc && typeof rawYrc === 'string' && rawYrc.includes('[')) {
        const lines = parseYrc(rawYrc);
        const payloadCheck = isValidFineGrainedPayload(lines);
        if (payloadCheck.valid) {
          const elrc = renderRawLinesToElrc(lines, options?.leadInMs ?? 500);
          const lrc = renderRawLinesToLrc(lines);

          log(`[NetEase] Successfully parsed raw YRC (${lines.length} lines, syllable-synced) for "${cand.name}".`);
          return {
            success: true,
            source: 'netease',
            format: 'YRC',
            trackTitle: cand.name,
            trackArtist: cand.artists,
            trackId: cand.id,
            lines,
            elrc: elrc || undefined,
            lrc: lrc || formatNeteaseLrc(lyricData?.lrc?.lyric || '') || undefined,
          };
        } else {
          log(`[NetEase] Candidate #${i + 1} YRC rejected: ${payloadCheck.reason}`);
        }
      }

      // Check standard LRC fallback from NetEase if YRC not present
      if (lyricData?.lrc?.lyric && typeof lyricData.lrc.lyric === 'string') {
        const lrcText = formatNeteaseLrc(lyricData.lrc.lyric.trim());
        const validLines = lrcText.split('\n').filter(l => {
          const content = l.replace(/^\[\d+:\d+(?:\.\d+)?\]/, '').trim();
          return content.length > 0 && !content.startsWith('作词') && !content.startsWith('作曲') && !content.startsWith('编曲') && !content.includes('纯音乐') && !content.includes('没有填词');
        });

        if (validLines.length >= 3) {
          log(`[NetEase] Candidate #${i + 1} has line-synced LRC only (${validLines.length} valid lyric lines, no YRC).`);
          return {
            success: true,
            source: 'netease',
            format: 'LRC',
            trackTitle: cand.name,
            trackArtist: cand.artists,
            trackId: cand.id,
            lrc: lrcText,
          };
        }
      }
    }

    return {
      success: false,
      source: 'netease',
      format: 'YRC',
      error: 'Candidates found, but none contained word-synced YRC lyrics',
    };
  } catch (err: any) {
    log(`[NetEase] Request error: ${err.message}`);
    return {
      success: false,
      source: 'netease',
      format: 'YRC',
      error: err.message || 'Unknown NetEase error',
    };
  }
}
