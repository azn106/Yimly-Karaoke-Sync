export type LyricProviderId = 'musixmatch' | 'netease' | 'qqmusic' | 'kugou';

export type LyricFormat = 'Richsync' | 'YRC' | 'QRC' | 'KRC' | 'LRC';

export interface RawLyricWord {
  text: string;
  startMs: number;
  durationMs: number;
}

export interface RawLyricLine {
  startMs: number;
  durationMs: number;
  words: RawLyricWord[];
  text: string;
}

export interface RawLyricSong {
  id: string | number;
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
  source: LyricProviderId;
  rawScore?: number;
}

export interface RawLyricResult {
  success: boolean;
  elrc?: string;
  lrc?: string;
  source: LyricProviderId;
  format: LyricFormat;
  trackTitle?: string;
  trackArtist?: string;
  trackId?: string | number;
  lines?: RawLyricLine[];
  error?: string;
}

export interface FetchLyricOptions {
  album?: string;
  duration?: number;
  leadInMs?: number;
  providers?: LyricProviderId[];
  onLog?: (msg: string) => void;
}

/**
 * Formats seconds or ms into standard LRC/eLRC mm:ss.xx format
 */
export function formatTimestamp(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = s.toFixed(2).padStart(5, '0');
  return `${mm}:${ss}`;
}

export function formatTimestampMs(ms: number): string {
  return formatTimestamp(ms / 1000);
}

export interface ParsedLrcLine {
  timestampSec: number;
  timestampMs: number;
  text: string;
  enhancedWords?: RawLyricWord[];
}

export interface ParsedLrcResult {
  metadata: Record<string, string>;
  offsetMs: number;
  lines: ParsedLrcLine[];
  isEnhanced: boolean;
  rawText: string;
}

/**
 * Parses timestamp string (e.g. "01:23.45" or "01:23.456" or "01:23") into milliseconds
 */
export function parseTimestampString(timeStr: string): number | null {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const match = timeStr.trim().match(/^(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const minutes = parseInt(match[1], 10);
  const seconds = parseInt(match[2], 10);
  let fractionMs = 0;
  if (match[3]) {
    const fractionStr = match[3].padEnd(3, '0').slice(0, 3);
    fractionMs = parseInt(fractionStr, 10);
  }
  return minutes * 60 * 1000 + seconds * 1000 + fractionMs;
}

/**
 * Robust parser for standard and enhanced LRC files:
 * - [mm:ss.xx] and [mm:ss.xxx] timestamps
 * - multiple timestamps per line (e.g. [00:01.00][00:15.00]Chorus)
 * - [offset: +/-ms] tags
 * - metadata tags ([ti:...], [ar:...], [al:...], [by:...], etc.)
 * - enhanced word-level tags (<mm:ss.xx>Word)
 * - Unicode, apostrophes, punctuation, empty lines
 * - Chronological sorting and duplicate timestamp handling
 */
export function parseLrc(lrcContent: string): ParsedLrcResult {
  if (!lrcContent || typeof lrcContent !== 'string') {
    return { metadata: {}, offsetMs: 0, lines: [], isEnhanced: false, rawText: '' };
  }

  const rawLines = lrcContent.split(/\r?\n/);
  const metadata: Record<string, string> = {};
  let offsetMs = 0;
  const parsedLines: ParsedLrcLine[] = [];
  let isEnhanced = false;

  // First pass: extract metadata tags
  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const metaMatch = trimmed.match(/^\[([a-zA-Z]+)\s*:\s*([^\]]*)\]$/);
    if (metaMatch) {
      const key = metaMatch[1].toLowerCase();
      const val = metaMatch[2].trim();
      metadata[key] = val;
      if (key === 'offset') {
        const parsedOffset = parseInt(val, 10);
        if (!isNaN(parsedOffset)) {
          offsetMs = parsedOffset;
        }
      }
    }
  }

  // Second pass: extract timed lines
  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Skip pure metadata lines
    if (/^\[[a-zA-Z]+\s*:\s*[^\]]*\]$/.test(trimmed)) {
      continue;
    }

    // Match all line-level timestamps: [mm:ss.xx]
    const timestampTagRegex = /\[(\d{1,3}:\d{2}(?:\.\d{1,3})?)\]/g;
    const timestampMatches: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = timestampTagRegex.exec(trimmed)) !== null) {
      timestampMatches.push(match[1]);
    }

    if (timestampMatches.length === 0) {
      continue;
    }

    // Strip line timestamps to get the lyric text
    const lineContent = trimmed.replace(timestampTagRegex, '').trim();

    // Check for word-level enhanced timing: <mm:ss.xx>Word or <mm:ss.xxx>Word
    const wordTagRegex = /<(\d{1,3}:\d{2}(?:\.\d{1,3})?)>([^<]*)/g;
    const words: RawLyricWord[] = [];
    let wMatch: RegExpExecArray | null;

    while ((wMatch = wordTagRegex.exec(lineContent)) !== null) {
      const wTsMs = parseTimestampString(wMatch[1]);
      const wText = wMatch[2];
      if (wTsMs !== null && wText.trim()) {
        const adjustedWordMs = Math.max(0, wTsMs + offsetMs);
        words.push({
          startMs: adjustedWordMs,
          durationMs: 0,
          text: wText.trim(),
        });
      }
    }

    if (words.length > 0) {
      isEnhanced = true;
    }

    const cleanLineText = words.length > 0
      ? words.map(w => w.text).join(' ').trim()
      : lineContent;

    for (const tsStr of timestampMatches) {
      const baseMs = parseTimestampString(tsStr);
      if (baseMs !== null) {
        const adjustedMs = Math.max(0, baseMs + offsetMs);
        parsedLines.push({
          timestampMs: adjustedMs,
          timestampSec: adjustedMs / 1000,
          text: cleanLineText,
          enhancedWords: words.length > 0 ? words : undefined,
        });
      }
    }
  }

  // Sort chronologically (stable sort)
  parsedLines.sort((a, b) => a.timestampMs - b.timestampMs);

  return {
    metadata,
    offsetMs,
    lines: parsedLines,
    isEnhanced,
    rawText: lrcContent,
  };
}

/**
 * Validates whether an LRC/eLRC content has substantive lyric lines
 */
export function isSubstantiveLrc(lrcContent: string): boolean {
  if (!lrcContent || typeof lrcContent !== 'string') return false;
  const parsed = parseLrc(lrcContent);
  if (parsed.lines.length < 3) return false;

  const validLines = parsed.lines.filter(l => {
    const t = l.text.trim();
    if (!t) return false;
    if (/^(作词|作曲|编曲|lyrics by|written by|produced by|title:|artist:|album:|纯音乐|没有填词)/i.test(t)) {
      return false;
    }
    return true;
  });

  return validLines.length >= 3;
}

/**
 * Normalizes an LRC string into cleanly sorted standard LRC [mm:ss.xx] lines
 */
export function normalizeLrc(lrcContent: string): string {
  const parsed = parseLrc(lrcContent);
  if (parsed.lines.length === 0) return '';

  const output: string[] = [];
  // Preserve metadata tags if present
  for (const [k, v] of Object.entries(parsed.metadata)) {
    if (k !== 'offset') {
      output.push(`[${k}:${v}]`);
    }
  }

  for (const line of parsed.lines) {
    output.push(`[${formatTimestamp(line.timestampSec)}]${line.text}`);
  }

  return output.join('\n');
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
 * Strips secondary noise from titles (e.g. (feat. ...), [Explicit], etc.) for accurate matching
 */
export function cleanTitle(title: string): string {
  if (!title) return '';
  const stripped = title
    .replace(/\s*[\(\[](?:feat\.?|ft\.?|featuring|with|remastered|remaster|radio edit|original mix|deluxe|bonus track|official|audio|video|music video|explicit|clean|anniversary|live|mono|stereo|album version|extended)[\s\S]*?[\)\]]/gi, '')
    .replace(/\s*-\s*(?:feat\.?|ft\.?|featuring|with|remastered|remaster|radio edit|original mix|deluxe|bonus track|official|audio|video|music video|explicit|clean|anniversary|live|mono|stereo|album version|extended)[\s\S]*$/gi, '')
    .trim();
  return normalizeText(stripped || title);
}

/**
 * Strips secondary noise from artist names (e.g. feat. ... or trailing details)
 */
export function cleanArtist(artist: string): string {
  if (!artist) return '';
  const stripped = artist
    .replace(/\s*(?:feat\.?|ft\.?|featuring|with|vs\.?)\s+.*$/gi, '')
    .replace(/[,;&/\\+].*$/, '')
    .trim();
  return normalizeText(stripped || artist);
}

/**
 * Splits multi-artist strings into individual normalized artist tokens
 */
export function extractArtistTokens(artist: string): string[] {
  if (!artist) return [];
  // Split on delimiters before stripping punctuation:
  // semicolon, comma, &, /, +, 、, feat, ft, featuring, with, vs
  const parts = artist.split(/[,;&/+\\、]|\b(?:feat\.?|ft\.?|featuring|with|vs\.?)\b/gi);
  return parts
    .map(p => normalizeText(p))
    .filter(p => p.length > 0 && !['various artists', 'unknown', 'feat', 'ft'].includes(p));
}

/**
 * Text similarity helper (Levenshtein-based ratio)
 */
export function textSimilarity(a: string, b: string): number {
  const s1 = a.trim().toLowerCase();
  const s2 = b.trim().toLowerCase();
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  const len1 = s1.length;
  const len2 = s2.length;
  const matrix: number[][] = [];

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  const distance = matrix[len1][len2];
  const maxLen = Math.max(len1, len2);
  return Math.max(0, (maxLen - distance) / maxLen);
}

/**
 * Evaluates artist similarity across direct string, cleaned string, and individual artist tokens
 */
export function calculateArtistSimilarity(queryArtist: string, candArtist: string): number {
  const qRaw = normalizeText(queryArtist);
  const cRaw = normalizeText(candArtist);
  if (!qRaw || !cRaw) return 0.0;
  if (qRaw === cRaw) return 1.0;

  const directSim = textSimilarity(qRaw, cRaw);
  const cleanSim = textSimilarity(cleanArtist(queryArtist), cleanArtist(candArtist));

  const qTokens = extractArtistTokens(queryArtist);
  const cTokens = extractArtistTokens(candArtist);

  let tokenSim = 0.0;
  if (qTokens.length > 0 && cTokens.length > 0) {
    // Check if primary query artist matches any candidate artist token
    for (const qt of qTokens) {
      for (const ct of cTokens) {
        if (qt === ct) {
          tokenSim = Math.max(tokenSim, 1.0);
        } else if (qt.length >= 3 && ct.length >= 3 && (ct.includes(qt) || qt.includes(ct))) {
          tokenSim = Math.max(tokenSim, 0.90);
        } else {
          const sim = textSimilarity(qt, ct);
          tokenSim = Math.max(tokenSim, sim);
        }
      }
    }
  }

  // Check substring containment on raw
  let subSim = 0.0;
  if (qRaw.length >= 3 && cRaw.length >= 3) {
    if (cRaw.includes(qRaw) || qRaw.includes(cRaw)) {
      subSim = 0.85;
    }
  }

  return Math.max(directSim, cleanSim, tokenSim, subSim);
}

/**
 * Evaluates title similarity across raw and cleaned representations
 */
export function calculateTitleSimilarity(queryTitle: string, candTitle: string): number {
  const qRaw = normalizeText(queryTitle);
  const cRaw = normalizeText(candTitle);
  if (!qRaw || !cRaw) return 0.0;
  if (qRaw === cRaw) return 1.0;

  const qClean = cleanTitle(queryTitle);
  const cClean = cleanTitle(candTitle);

  if (qClean && cClean && qClean === cClean) return 1.0;

  const rawSim = textSimilarity(qRaw, cRaw);
  const cleanSim = textSimilarity(qClean, cClean);

  let subSim = 0.0;
  if (qClean.length >= 3 && cClean.length >= 3) {
    if (cClean.startsWith(qClean) || qClean.startsWith(cClean)) {
      subSim = 0.90;
    } else if (cClean.includes(qClean) || qClean.includes(cClean)) {
      subSim = 0.80;
    }
  }

  return Math.max(rawSim, cleanSim, subSim);
}

export const MIN_MATCH_SCORE = 50;

export interface MatchScoreResult {
  score: number;
  durationPassed: boolean;
  isValid: boolean;
  reason: string;
  titleScore: number;
  artistScore: number;
}

/**
 * Validates whether a parsed fine-grained lyric representation is complete and substantive.
 * Prevents accepting stubs, truncated previews, or pure metadata headers (e.g. 2 lines of credits with 0 lyrics).
 */
export function isValidFineGrainedPayload(
  lines: RawLyricLine[],
  minLines = 4,
  minWords = 15
): { valid: boolean; reason?: string } {
  if (!lines || lines.length === 0) {
    return { valid: false, reason: 'Empty fine-grained lyric payload' };
  }

  // Count lines that contain actual lyric words (not purely header/credits like 作词/作曲/Lyrics by/Title)
  const substantiveLines = lines.filter(line => {
    const lineText = (line.text || line.words.map(w => w.text).join('')).trim();
    if (!lineText) return false;
    // Exclude title/artist header credits lines
    if (/^(作词|作曲|编曲|lyrics by|written by|produced by|title:|artist:|album:)/i.test(lineText)) {
      return false;
    }
    return true;
  });

  const totalWords = lines.reduce((acc, l) => acc + (l.words ? l.words.length : 0), 0);

  if (substantiveLines.length < minLines) {
    return {
      valid: false,
      reason: `Incomplete fine-grained payload: only ${substantiveLines.length} substantive lyric lines (minimum required: ${minLines})`,
    };
  }

  if (totalWords < minWords) {
    return {
      valid: false,
      reason: `Incomplete fine-grained payload: only ${totalWords} total words (minimum required: ${minWords})`,
    };
  }

  return { valid: true };
}

/**
 * Generates clean API search query variants to handle semicolon/multi-artist tags and feat titles
 */
export function buildApiSearchQueries(title: string, artist: string): string[] {
  const queries: string[] = [];

  // 1. Sanitized query with semicolons replaced by spaces and feat tags removed from title
  const artistNoSemi = artist.replace(/;/g, ' ').replace(/\s+/g, ' ').trim();
  const titleClean = title.replace(/\s*[\(\[](?:feat\.?|ft\.?|featuring|with)[\s\S]*?[\)\]]/gi, '').trim();
  const q1 = `${artistNoSemi} ${titleClean}`.trim();
  if (q1) queries.push(q1);

  // 2. Primary artist + clean title
  const cArtist = cleanArtist(artist);
  const cTitle = cleanTitle(title);
  if (cArtist && cTitle) {
    const q2 = `${cArtist} ${cTitle}`.trim();
    if (!queries.includes(q2)) queries.push(q2);
  }

  // 3. Raw input fallback
  const rawQ = `${artist} ${title}`.trim();
  if (!queries.includes(rawQ)) queries.push(rawQ);

  return queries;
}

/**
 * Calculate match score between query and candidate metadata with strict validation gates
 */
export function calculateMatchScore(
  queryTitle: string,
  queryArtist: string,
  candTitle: string,
  candArtist: string,
  queryDuration?: number,
  candDuration?: number
): MatchScoreResult {
  // Check duration tolerance (max 6.0 seconds difference if duration is known on both)
  let durationPassed = true;
  let durationPenalty = 0;
  if (queryDuration && candDuration && queryDuration > 0 && candDuration > 0) {
    const diffSec = Math.abs(queryDuration - candDuration);
    if (diffSec > 6.0) {
      return {
        score: 0,
        durationPassed: false,
        isValid: false,
        titleScore: 0,
        artistScore: 0,
        reason: `Duration difference (${diffSec.toFixed(1)}s) exceeds tolerance (6.0s)`,
      };
    }
    if (diffSec > 3.0) {
      durationPenalty = (diffSec - 3.0) * 8;
    }
  }

  const titleSim = calculateTitleSimilarity(queryTitle, candTitle);
  const artistSim = calculateArtistSimilarity(queryArtist, candArtist);

  const titleScore = Math.round(titleSim * 100);
  const artistScore = Math.round(artistSim * 100);

  // Strict Validation Gates:
  // 1. Title must meet minimum similarity threshold (at least 45%)
  if (titleSim < 0.45) {
    return {
      score: 0,
      durationPassed: true,
      isValid: false,
      titleScore,
      artistScore,
      reason: `Title mismatch: ${titleScore}% (minimum required: 45%)`,
    };
  }

  // 2. Artist must meet minimum similarity threshold (at least 30%)
  if (artistSim < 0.30) {
    return {
      score: Math.min(34, Math.round(titleScore * 0.5)),
      durationPassed: true,
      isValid: false,
      titleScore,
      artistScore,
      reason: `Artist mismatch: candidate "${candArtist}" (${artistScore}%) vs requested "${queryArtist}"`,
    };
  }

  // Calculate weighted total score
  let baseScore = titleScore * 0.60 + artistScore * 0.40 - durationPenalty;

  // Bonus for near-perfect matches on both
  if (titleSim >= 0.90 && artistSim >= 0.80) {
    baseScore = Math.max(baseScore, 90);
  }

  const score = Math.max(0, Math.min(100, Math.round(baseScore)));
  const isValid = score >= MIN_MATCH_SCORE && durationPassed;

  return {
    score,
    durationPassed,
    isValid,
    titleScore,
    artistScore,
    reason: `Title: ${titleScore}%, Artist: ${artistScore}% (Overall: ${score}${isValid ? ' - VALID' : ' - REJECTED'})`,
  };
}

/**
 * Renders parsed RawLyricLine[] to standard Yimly Sync eLRC (.elrc.lrc)
 */
export function renderRawLinesToElrc(lines: RawLyricLine[], leadInMs = 500): string | null {
  if (!lines || lines.length === 0) return null;

  const safeLeadInMs = Math.max(0, Math.min(5000, leadInMs));
  const safeLeadInSec = safeLeadInMs / 1000;
  const outputLines: string[] = [];

  for (const line of lines) {
    const lineStartSec = line.startMs / 1000;
    const wordTokens: string[] = [];
    let firstWordTsSec: number | null = null;

    if (line.words && line.words.length > 0) {
      for (const w of line.words) {
        const text = w.text.trim();
        if (!text) continue;
        const wordStartSec = w.startMs / 1000;
        if (firstWordTsSec === null) {
          firstWordTsSec = wordStartSec;
        }
        wordTokens.push(`<${formatTimestamp(wordStartSec)}>${text}`);
      }
    }

    const baseTsSec = firstWordTsSec !== null ? firstWordTsSec : lineStartSec;
    const outerLineTs = Math.max(0, Math.round((baseTsSec - safeLeadInSec) * 100) / 100);
    const outerLineFormatted = formatTimestamp(outerLineTs);

    if (wordTokens.length > 0) {
      outputLines.push(`[${outerLineFormatted}] ${wordTokens.join(' ')}`);
    } else if (line.text && line.text.trim()) {
      outputLines.push(`[${outerLineFormatted}] ${line.text.trim()}`);
    } else {
      outputLines.push(`[${outerLineFormatted}]`);
    }
  }

  return outputLines.length > 0 ? outputLines.join('\n') : null;
}

/**
 * Renders parsed RawLyricLine[] to standard line-synced LRC (.lrc)
 */
export function renderRawLinesToLrc(lines: RawLyricLine[]): string | null {
  if (!lines || lines.length === 0) return null;
  const outputLines: string[] = [];

  for (const line of lines) {
    const lineStartSec = line.startMs / 1000;
    const formatted = formatTimestamp(lineStartSec);
    const text = (line.text || line.words.map(w => w.text).join('')).trim();
    if (text) {
      outputLines.push(`[${formatted}]${text}`);
    }
  }

  return outputLines.length > 0 ? outputLines.join('\n') : null;
}
