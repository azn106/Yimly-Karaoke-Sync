import { getSettings } from '../config.js';
import { LyricProviderId, RawLyricResult, FetchLyricOptions } from './types.js';
import { fetchMusixmatchLyrics, fetchMusixmatchStandardLrc } from './musixmatchAdapter.js';
import { fetchNeteaseLyrics } from './netease.js';
import { fetchQQMusicLyrics } from './qqmusic.js';
import { fetchKugouLyrics } from './kugou.js';

export const DEFAULT_PROVIDER_ORDER: LyricProviderId[] = [
  'netease',
  'qqmusic',
  'kugou',
  'musixmatch',
];

export const PROVIDER_DISPLAY_NAMES: Record<LyricProviderId, string> = {
  netease: 'NetEase (YRC)',
  qqmusic: 'QQ Music (QRC)',
  kugou: 'Kugou (KRC)',
  musixmatch: 'Musixmatch (Richsync)',
};

export function getActiveProviderList(): LyricProviderId[] {
  try {
    const settings = getSettings();
    const configured = settings.lyrics?.providers;
    if (Array.isArray(configured) && configured.length > 0) {
      return configured.filter((p): p is LyricProviderId =>
        ['netease', 'qqmusic', 'kugou', 'musixmatch'].includes(p)
      );
    }
  } catch {}
  return [...DEFAULT_PROVIDER_ORDER];
}

export interface DualLyricRetrievalResult {
  elrcResult?: {
    elrc: string;
    source: LyricProviderId;
    format: string;
    lineCount: number;
    wordCount: number;
    trackTitle?: string;
    trackArtist?: string;
  };
  lrcResult?: {
    lrc: string;
    source: LyricProviderId;
    format: string;
    lineCount: number;
    trackTitle?: string;
    trackArtist?: string;
  };
  steps: {
    provider: LyricProviderId;
    searched: boolean;
    yrcOrFineFound: boolean;
    lrcFound: boolean;
    error?: string;
  }[];
}

/**
 * Searches across the strict fallback chain [NetEase -> QQ Music -> Kugou -> Musixmatch]
 * until BOTH word-synced (.elrc.lrc) and standard line-synced (.lrc) representations
 * are found, or all providers are exhausted.
 */
export async function fetchSongDualLyrics(
  title: string,
  artist: string,
  album?: string,
  duration?: number,
  options?: {
    leadInMs?: number;
    providers?: LyricProviderId[];
    needElrc?: boolean;
    needLrc?: boolean;
    onLog?: (msg: string) => void;
  }
): Promise<DualLyricRetrievalResult> {
  const log = options?.onLog || (() => {});
  const providers = options?.providers || getActiveProviderList();

  let needElrc = options?.needElrc !== false;
  let needLrc = options?.needLrc !== false;

  const result: DualLyricRetrievalResult = {
    steps: [],
  };

  log(`[LyricEngine] Starting dual-representation search for "${title}" by "${artist}" across [${providers.join(' -> ')}] (need eLRC: ${needElrc}, need LRC: ${needLrc})`);

  for (const provider of providers) {
    if (!needElrc && !needLrc) {
      log(`[LyricEngine] Both lyric representations satisfied. Halting provider chain.`);
      break;
    }

    const providerName = PROVIDER_DISPLAY_NAMES[provider] || provider;
    log(`[LyricEngine] Querying provider #${result.steps.length + 1}: ${providerName} (looking for:${needElrc ? ' .elrc.lrc' : ''}${needLrc ? ' .lrc' : ''})...`);

    const stepInfo = {
      provider,
      searched: true,
      yrcOrFineFound: false,
      lrcFound: false,
      error: undefined as string | undefined,
    };

    try {
      const fetchOpts: FetchLyricOptions = {
        album,
        duration,
        leadInMs: options?.leadInMs,
        onLog: log,
      };

      if (provider === 'netease') {
        const provRes = await fetchNeteaseLyrics(title, artist, fetchOpts);
        if (provRes && provRes.success) {
          if (needElrc && provRes.elrc) {
            const lines = provRes.elrc.split('\n').filter(Boolean);
            const wordCount = (provRes.elrc.match(/<\d{2}:\d{2}\.\d{2}>/g) || []).length;
            result.elrcResult = {
              elrc: provRes.elrc,
              source: 'netease',
              format: provRes.format,
              lineCount: lines.length,
              wordCount,
              trackTitle: provRes.trackTitle,
              trackArtist: provRes.trackArtist,
            };
            stepInfo.yrcOrFineFound = true;
            needElrc = false;
            log(`[LyricEngine] NetEase provided fine-grained lyrics (${provRes.format} -> .elrc.lrc, ${lines.length} lines, ${wordCount} words).`);
          }
          if (needLrc && provRes.lrc) {
            const lines = provRes.lrc.split('\n').filter(Boolean);
            result.lrcResult = {
              lrc: provRes.lrc,
              source: 'netease',
              format: 'LRC',
              lineCount: lines.length,
              trackTitle: provRes.trackTitle,
              trackArtist: provRes.trackArtist,
            };
            stepInfo.lrcFound = true;
            needLrc = false;
            log(`[LyricEngine] NetEase provided standard line-synced LRC (${lines.length} lines).`);
          }
        } else if (provRes && !provRes.success) {
          stepInfo.error = provRes.error;
        }
      } else if (provider === 'qqmusic') {
        const provRes = await fetchQQMusicLyrics(title, artist, fetchOpts);
        if (provRes && provRes.success) {
          if (needElrc && provRes.elrc) {
            const lines = provRes.elrc.split('\n').filter(Boolean);
            const wordCount = (provRes.elrc.match(/<\d{2}:\d{2}\.\d{2}>/g) || []).length;
            result.elrcResult = {
              elrc: provRes.elrc,
              source: 'qqmusic',
              format: provRes.format,
              lineCount: lines.length,
              wordCount,
              trackTitle: provRes.trackTitle,
              trackArtist: provRes.trackArtist,
            };
            stepInfo.yrcOrFineFound = true;
            needElrc = false;
            log(`[LyricEngine] QQ Music provided fine-grained lyrics (${provRes.format} -> .elrc.lrc, ${lines.length} lines, ${wordCount} words).`);
          }
          if (needLrc && provRes.lrc) {
            const lines = provRes.lrc.split('\n').filter(Boolean);
            result.lrcResult = {
              lrc: provRes.lrc,
              source: 'qqmusic',
              format: 'LRC',
              lineCount: lines.length,
              trackTitle: provRes.trackTitle,
              trackArtist: provRes.trackArtist,
            };
            stepInfo.lrcFound = true;
            needLrc = false;
            log(`[LyricEngine] QQ Music provided standard line-synced LRC (${lines.length} lines).`);
          }
        } else if (provRes && !provRes.success) {
          stepInfo.error = provRes.error;
        }
      } else if (provider === 'kugou') {
        const provRes = await fetchKugouLyrics(title, artist, fetchOpts);
        if (provRes && provRes.success) {
          if (needElrc && provRes.elrc) {
            const lines = provRes.elrc.split('\n').filter(Boolean);
            const wordCount = (provRes.elrc.match(/<\d{2}:\d{2}\.\d{2}>/g) || []).length;
            result.elrcResult = {
              elrc: provRes.elrc,
              source: 'kugou',
              format: provRes.format,
              lineCount: lines.length,
              wordCount,
              trackTitle: provRes.trackTitle,
              trackArtist: provRes.trackArtist,
            };
            stepInfo.yrcOrFineFound = true;
            needElrc = false;
            log(`[LyricEngine] Kugou provided fine-grained lyrics (${provRes.format} -> .elrc.lrc, ${lines.length} lines, ${wordCount} words).`);
          }
          if (needLrc && provRes.lrc) {
            const lines = provRes.lrc.split('\n').filter(Boolean);
            result.lrcResult = {
              lrc: provRes.lrc,
              source: 'kugou',
              format: 'LRC',
              lineCount: lines.length,
              trackTitle: provRes.trackTitle,
              trackArtist: provRes.trackArtist,
            };
            stepInfo.lrcFound = true;
            needLrc = false;
            log(`[LyricEngine] Kugou provided standard line-synced LRC (${lines.length} lines).`);
          }
        } else if (provRes && !provRes.success) {
          stepInfo.error = provRes.error;
        }
      } else if (provider === 'musixmatch') {
        // Musixmatch is always the 4th/final fallback
        if (needElrc) {
          const mxRes = await fetchMusixmatchLyrics(title, artist, fetchOpts);
          if (mxRes.success && mxRes.elrc) {
            const lines = mxRes.elrc.split('\n').filter(Boolean);
            const wordCount = (mxRes.elrc.match(/<\d{2}:\d{2}\.\d{2}>/g) || []).length;
            result.elrcResult = {
              elrc: mxRes.elrc,
              source: 'musixmatch',
              format: 'Richsync',
              lineCount: lines.length,
              wordCount,
              trackTitle: mxRes.trackTitle,
              trackArtist: mxRes.trackArtist,
            };
            stepInfo.yrcOrFineFound = true;
            needElrc = false;
            log(`[LyricEngine] Musixmatch provided fine-grained Richsync (.elrc.lrc, ${lines.length} lines, ${wordCount} words).`);
          }
        }

        if (needLrc) {
          const mxLrcRes = await fetchMusixmatchStandardLrc(title, artist, fetchOpts);
          if (mxLrcRes.success && mxLrcRes.lrc) {
            const lines = mxLrcRes.lrc.split('\n').filter(Boolean);
            result.lrcResult = {
              lrc: mxLrcRes.lrc,
              source: 'musixmatch',
              format: 'LRC',
              lineCount: lines.length,
              trackTitle: mxLrcRes.trackTitle,
              trackArtist: mxLrcRes.trackArtist,
            };
            stepInfo.lrcFound = true;
            needLrc = false;
            log(`[LyricEngine] Musixmatch provided standard line-synced LRC (${lines.length} lines).`);
          }
        }
      }
    } catch (err: any) {
      stepInfo.error = err.message;
      log(`[LyricEngine] Error querying ${providerName}: ${err.message}`);
    }

    result.steps.push(stepInfo);
  }

  log(`[LyricEngine] Search complete. eLRC: ${result.elrcResult ? `Found via ${result.elrcResult.source}` : 'NOT FOUND'}, LRC: ${result.lrcResult ? `Found via ${result.lrcResult.source}` : 'NOT FOUND'}`);
  return result;
}

/**
 * Executes a prioritized fetch across enabled providers for word-synced eLRC
 */
export async function fetchUnifiedElrc(
  title: string,
  artist: string,
  album?: string,
  duration?: number,
  options?: {
    leadInMs?: number;
    providers?: LyricProviderId[];
    onLog?: (msg: string) => void;
  }
): Promise<RawLyricResult> {
  const log = options?.onLog || (() => {});
  const providers = options?.providers || getActiveProviderList();

  log(`[LyricEngine] Initiating multi-provider eLRC search for "${title}" by "${artist}" across: [${providers.join(', ')}]`);

  const errors: string[] = [];

  for (const provider of providers) {
    log(`[LyricEngine] Trying provider: ${PROVIDER_DISPLAY_NAMES[provider] || provider}...`);

    try {
      let result: RawLyricResult | null = null;
      const fetchOpts: FetchLyricOptions = {
        album,
        duration,
        leadInMs: options?.leadInMs,
        onLog: log,
      };

      if (provider === 'netease') {
        result = await fetchNeteaseLyrics(title, artist, fetchOpts);
      } else if (provider === 'qqmusic') {
        result = await fetchQQMusicLyrics(title, artist, fetchOpts);
      } else if (provider === 'kugou') {
        result = await fetchKugouLyrics(title, artist, fetchOpts);
      } else if (provider === 'musixmatch') {
        result = await fetchMusixmatchLyrics(title, artist, fetchOpts);
      }

      if (result && result.success && result.elrc) {
        log(`[LyricEngine] SUCCESS! Satisfied by ${PROVIDER_DISPLAY_NAMES[provider]} (${result.format}).`);
        return result;
      } else {
        const errMsg = result?.error || 'No syllable-synced lyrics';
        errors.push(`${provider}: ${errMsg}`);
        log(`[LyricEngine] ${provider} did not satisfy request: ${errMsg}. Moving to next provider.`);
      }
    } catch (err: any) {
      errors.push(`${provider}: ${err.message}`);
      log(`[LyricEngine] Provider ${provider} failed with error: ${err.message}`);
    }
  }

  return {
    success: false,
    source: providers[0] || 'musixmatch',
    format: 'Richsync',
    error: `All providers exhausted without finding word-synced lyrics. (${errors.join(' | ')})`,
  };
}

/**
 * Executes a prioritized fetch across enabled providers for standard line-synced LRC
 */
export async function fetchUnifiedLrc(
  title: string,
  artist: string,
  album?: string,
  duration?: number,
  options?: {
    providers?: LyricProviderId[];
    onLog?: (msg: string) => void;
  }
): Promise<RawLyricResult> {
  const log = options?.onLog || (() => {});
  const providers = options?.providers || getActiveProviderList();

  log(`[LyricEngine] Initiating multi-provider standard LRC search for "${title}" by "${artist}"...`);

  for (const provider of providers) {
    try {
      const fetchOpts: FetchLyricOptions = {
        album,
        duration,
        onLog: log,
      };

      let result: RawLyricResult | null = null;
      if (provider === 'netease') {
        result = await fetchNeteaseLyrics(title, artist, fetchOpts);
      } else if (provider === 'qqmusic') {
        result = await fetchQQMusicLyrics(title, artist, fetchOpts);
      } else if (provider === 'kugou') {
        result = await fetchKugouLyrics(title, artist, fetchOpts);
      } else if (provider === 'musixmatch') {
        result = await fetchMusixmatchStandardLrc(title, artist, fetchOpts);
      }

      if (result && result.success && result.lrc) {
        log(`[LyricEngine] Standard LRC satisfied by ${PROVIDER_DISPLAY_NAMES[provider]}.`);
        return result;
      }
    } catch (err: any) {
      log(`[LyricEngine] Provider ${provider} LRC error: ${err.message}`);
    }
  }

  return {
    success: false,
    source: providers[0] || 'musixmatch',
    format: 'LRC',
    error: 'All providers exhausted without finding line-synced LRC',
  };
}
