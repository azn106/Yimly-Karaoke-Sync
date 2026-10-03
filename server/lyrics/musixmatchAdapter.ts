import { fetchElrc, fetchLrc, matchTrack, fetchSubtitleLrc } from '../musixmatch.js';
import { RawLyricResult, FetchLyricOptions } from './types.js';

/**
 * Adapter that cleanly connects the existing, untouched Musixmatch provider
 * to the unified RawLyricResult interface.
 */
export async function fetchMusixmatchLyrics(
  title: string,
  artist: string,
  options?: FetchLyricOptions
): Promise<RawLyricResult> {
  const log = options?.onLog || (() => {});
  log(`[Musixmatch] Querying Richsync & subtitles for "${title}" by "${artist}"...`);

  try {
    const elrcRes = await fetchElrc(
      title,
      artist,
      options?.album,
      options?.duration,
      options?.leadInMs
    );

    if (elrcRes.success && elrcRes.elrc) {
      log(`[Musixmatch] Richsync (word-synced) retrieved successfully.`);

      // Also try fetching standard LRC subtitle
      let standardLrc: string | undefined;
      try {
        const subRes = await fetchSubtitleLrc(title, artist);
        if (subRes) standardLrc = subRes;
      } catch {}

      return {
        success: true,
        source: 'musixmatch',
        format: 'Richsync',
        trackTitle: title,
        trackArtist: artist,
        elrc: elrcRes.elrc,
        lrc: standardLrc,
      };
    }

    return {
      success: false,
      source: 'musixmatch',
      format: 'Richsync',
      error: elrcRes.error || 'Richsync not available',
    };
  } catch (err: any) {
    log(`[Musixmatch] Error: ${err.message}`);
    return {
      success: false,
      source: 'musixmatch',
      format: 'Richsync',
      error: err.message || 'Unknown Musixmatch error',
    };
  }
}

export async function fetchMusixmatchStandardLrc(
  title: string,
  artist: string,
  options?: FetchLyricOptions
): Promise<RawLyricResult> {
  const log = options?.onLog || (() => {});
  try {
    const lrcRes = await fetchLrc(title, artist, options?.album, options?.duration);
    if (lrcRes.success && lrcRes.lrc) {
      return {
        success: true,
        source: 'musixmatch',
        format: 'LRC',
        trackTitle: title,
        trackArtist: artist,
        lrc: lrcRes.lrc,
      };
    }
    return {
      success: false,
      source: 'musixmatch',
      format: 'LRC',
      error: lrcRes.error || 'LRC not available',
    };
  } catch (err: any) {
    log(`[Musixmatch] Error: ${err.message}`);
    return {
      success: false,
      source: 'musixmatch',
      format: 'LRC',
      error: err.message || 'Unknown Musixmatch error',
    };
  }
}
