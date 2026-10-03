import crypto from 'crypto';
import zlib from 'zlib';
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

// Kugou XOR key from LDDC
const KRC_KEY = Buffer.from([
  0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47,
  0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69,
]);

// Kugou search signature salt
const KUGOU_SALT = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA';

function generateKugouSignature(params: Record<string, any>): string {
  const keys = Object.keys(params).sort();
  let str = '';
  for (const k of keys) {
    str += `${k}=${params[k]}`;
  }
  return crypto.createHash('md5').update(`${KUGOU_SALT}${str}${KUGOU_SALT}`).digest('hex');
}

/**
 * Decrypts Kugou KRC payload (XOR + zlib inflate)
 */
export function krcDecrypt(data: Buffer): string {
  if (data.length < 4) {
    throw new Error('KRC payload too short');
  }

  // First 4 bytes are magic 'krc1'
  const body = data.subarray(4);
  const xorBuf = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i++) {
    xorBuf[i] = body[i] ^ KRC_KEY[i % KRC_KEY.length];
  }

  const inflated = zlib.inflateSync(xorBuf);
  return inflated.toString('utf8');
}

/**
 * Parses Kugou KRC raw content into structured RawLyricLine[]
 * Format:
 * [lineStart, lineDuration]<wordOffset, wordDuration, flag>word ...
 */
export function parseKrc(krcText: string): RawLyricLine[] {
  if (!krcText || typeof krcText !== 'string') return [];

  const rawLines = krcText.split('\n');
  const parsedLines: RawLyricLine[] = [];

  const lineRegex = /^\[(\d+),(\d+)\](.*)$/;
  const wordRegex = /<(\d+),(\d+),\d+>([^<]*)/g;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Skip metadata tags such as [ti:...], [ar:...], [language:...]
    if (/^\[[a-zA-Z]+:.*\]$/.test(trimmed)) {
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
      const offsetMs = parseInt(wMatch[1], 10);
      const wDurMs = parseInt(wMatch[2], 10);
      const wText = wMatch[3];
      if (wText) {
        words.push({
          text: wText,
          startMs: lineStartMs + offsetMs,
          durationMs: wDurMs,
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

/**
 * Search Kugou for matching songs and retrieve word-synced KRC lyrics
 */
export async function fetchKugouLyrics(
  title: string,
  artist: string,
  options?: FetchLyricOptions
): Promise<RawLyricResult> {
  const log = options?.onLog || (() => {});
  // Sanitize query by removing semicolons and title feat noise
  const sanitizedArtist = artist.replace(/;/g, ' ').replace(/\s+/g, ' ').trim();
  const sanitizedTitle = title.replace(/\s*[\(\[](?:feat\.?|ft\.?|featuring|with)[\s\S]*?[\)\]]/gi, '').trim();
  const query = `${sanitizedArtist} - ${sanitizedTitle}`.trim() || `${artist} - ${title}`.trim();
  log(`[Kugou] Searching for "${query}"...`);

  try {
    let songList: any[] = [];

  // Try mobilecdn search API (standard mobile endpoint, no signature required)
  try {
    const mobileUrl = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(query)}&page=1&pagesize=15`;
    const searchRes = await fetch(mobileUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (searchRes.ok) {
      const searchData: any = await searchRes.json();
      songList = searchData?.data?.info || [];
    }
  } catch (err: any) {
    log(`[Kugou] Mobile search attempt 1 failed: ${err.message}`);
  }

  // Fallback to complexsearch if mobilecdn returned nothing
  if (songList.length === 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    const mid = crypto.createHash('md5').update(String(Date.now())).digest('hex');

    const searchParams: Record<string, any> = {
      appid: 1005,
      bitrate: 0,
      callback: '',
      clienttime: nowSec,
      clientver: 1000,
      filter: 10,
      inputtype: 0,
      iscorrection: 1,
      isfp: 0,
      keyword: query,
      mid,
      page: 1,
      pagesize: 10,
      platform: 'pc',
      privilege_filter: 0,
      srcappid: 2919,
      tag: 'em',
      userid: 0,
      uuid: mid,
    };

    searchParams['signature'] = generateKugouSignature(searchParams);

    try {
      const queryStr = Object.keys(searchParams)
        .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(searchParams[k])}`)
        .join('&');

      const searchRes = await fetch(`http://complexsearch.kugou.com/v2/search/song?${queryStr}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (searchRes.ok) {
        const searchData: any = await searchRes.json();
        songList = searchData?.data?.lists || [];
      }
    } catch (err: any) {
      log(`[Kugou] Complex search attempt failed: ${err.message}`);
    }
  }

  if (songList.length === 0) {
    log(`[Kugou] No songs found matching "${query}".`);
    return {
      success: false,
      source: 'kugou',
      format: 'KRC',
      error: 'No matching tracks found on Kugou',
    };
  }

  // Rank candidates
  interface Candidate {
    fileHash: string;
    songName: string;
    singerName: string;
    durationSec: number;
    score: number;
    reason: string;
  }

  const candidates: Candidate[] = [];

  for (const song of songList) {
    const hash = song.hash || song.sqhash || song['320hash'] || song.FileHash || song.HQFileHash || song.SQFileHash;
    if (!hash) continue;

    const rawSongName = (song.songname || song.SongName || '').replace(/<\/?em>/g, '');
    const rawSingerName = (song.singername || song.SingerName || '').replace(/<\/?em>/g, '');
    const durationSec = song.duration || song.Duration || 0;

    const match = calculateMatchScore(
      title,
      artist,
      rawSongName,
      rawSingerName,
      options?.duration,
      durationSec
    );

    if (match.durationPassed && match.isValid && match.score >= MIN_MATCH_SCORE) {
      candidates.push({
        fileHash: hash,
        songName: rawSongName,
        singerName: rawSingerName,
        durationSec,
        score: match.score,
        reason: match.reason,
      });
    }
  }

    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      log(`[Kugou] Found ${songList.length} results, but none satisfied duration/metadata thresholds.`);
      return {
        success: false,
        source: 'kugou',
        format: 'KRC',
        error: 'No candidate satisfied duration tolerance and metadata score',
      };
    }

    // Try candidates
    for (let i = 0; i < Math.min(3, candidates.length); i++) {
      const cand = candidates[i];
      log(`[Kugou] Querying lyrics for candidate #${i + 1}: "${cand.songName}" by "${cand.singerName}" (Hash: ${cand.fileHash}, score: ${cand.score})...`);

      const nowMs = Date.now();
      const mid = crypto.createHash('md5').update(String(nowMs)).digest('hex');

      const searchLyricParams: Record<string, any> = {
        album_audio_id: 0,
        appid: '3116',
        clientver: '11070',
        duration: Math.round(cand.durationSec * 1000),
        hash: cand.fileHash,
        keyword: `${cand.singerName} - ${cand.songName}`,
        lrctxt: '1',
        man: 'no',
        ver: '1',
      };
      searchLyricParams.signature = generateKugouSignature(searchLyricParams);

      const queryStr = Object.keys(searchLyricParams)
        .map(k => `${k}=${encodeURIComponent(searchLyricParams[k])}`)
        .join('&');
      const lyricSearchUrl = `https://lyrics.kugou.com/v1/search?${queryStr}`;

      const lyricSearchRes = await fetch(lyricSearchUrl, {
        headers: {
          'User-Agent': 'Android14-1070-11070-201-0-Lyric-wifi',
          'KG-Rec': '1',
          'KG-RC': '1',
          'KG-CLIENTTIMEMS': String(nowMs),
          mid,
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!lyricSearchRes.ok) continue;

      const lyricSearchData: any = await lyricSearchRes.json();
      const candidatesList = lyricSearchData?.candidates || [];
      if (candidatesList.length === 0) continue;

      const firstCandidate = candidatesList[0];
      const dlParams: Record<string, any> = {
        accesskey: firstCandidate.accesskey,
        appid: '3116',
        charset: 'utf8',
        client: 'mobi',
        clientver: '11070',
        fmt: 'krc',
        id: firstCandidate.id,
        ver: '1',
      };
      dlParams.signature = generateKugouSignature(dlParams);

      const dlQuery = Object.keys(dlParams)
        .map(k => `${k}=${encodeURIComponent(dlParams[k])}`)
        .join('&');
      const downloadUrl = `http://lyrics.kugou.com/download?${dlQuery}`;

      const downloadRes = await fetch(downloadUrl, {
        headers: {
          'User-Agent': 'Android14-1070-11070-201-0-Lyric-wifi',
          'KG-Rec': '1',
          'KG-RC': '1',
          'KG-CLIENTTIMEMS': String(Date.now()),
          mid,
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!downloadRes.ok) continue;

      const downloadData: any = await downloadRes.json();
      const b64Content = downloadData?.content;
      if (!b64Content || typeof b64Content !== 'string') continue;

      try {
        const rawBuf = Buffer.from(b64Content, 'base64');
        const decryptedKrc = krcDecrypt(rawBuf);

        const lines = parseKrc(decryptedKrc);
        const payloadCheck = isValidFineGrainedPayload(lines);
        if (payloadCheck.valid) {
          const elrc = renderRawLinesToElrc(lines, options?.leadInMs ?? 500);
          const lrc = renderRawLinesToLrc(lines);

          log(`[Kugou] Successfully decrypted and parsed raw KRC (${lines.length} lines, word-synced) for "${cand.songName}".`);
          return {
            success: true,
            source: 'kugou',
            format: 'KRC',
            trackTitle: cand.songName,
            trackArtist: cand.singerName,
            trackId: cand.fileHash,
            lines,
            elrc: elrc || undefined,
            lrc: lrc || undefined,
          };
        } else {
          log(`[Kugou] Candidate #${i + 1} KRC rejected: ${payloadCheck.reason}`);
        }
      } catch (decErr: any) {
        log(`[Kugou] Candidate #${i + 1} KRC decryption failed: ${decErr.message}`);
      }
    }

    return {
      success: false,
      source: 'kugou',
      format: 'KRC',
      error: 'Candidates found, but none contained word-synced KRC lyrics',
    };
  } catch (err: any) {
    log(`[Kugou] Request error: ${err.message}`);
    return {
      success: false,
      source: 'kugou',
      format: 'KRC',
      error: err.message || 'Unknown Kugou error',
    };
  }
}
