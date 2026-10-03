import React, { useState, useRef, useEffect, useMemo } from 'react';
import { 
  Music, 
  FileText, 
  CheckCircle2, 
  AlertCircle, 
  Play, 
  FileEdit, 
  Headphones 
} from 'lucide-react';
import { SongItem } from '../types.js';

export interface SongCardProps {
  song: SongItem;
  isAdmin: boolean;
  onPreviewAudio: (filePath: string, title: string) => void;
  onEditLyrics: (song: SongItem) => void;
  onEnqueueSong: (filePath: string, artistName: string) => void;
}

export const SongCard = React.memo<SongCardProps>(({
  song,
  isAdmin,
  onPreviewAudio,
  onEditLyrics,
  onEnqueueSong,
}) => {
  return (
    <div
      className={`p-3.5 sm:p-5 rounded-2xl border transition shadow-md h-full flex flex-col justify-between ${
        song.isComplete
          ? 'bg-[#1E293B] border-slate-800 hover:border-emerald-500/30'
          : 'bg-[#1E293B] border-[#FF4FA3]/25 hover:border-[#FF4FA3]/40'
      }`}
    >
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3.5 sm:gap-4">
        {/* Track info */}
        <div className="space-y-1.5 min-w-0 flex-1">
          <div className="flex items-center space-x-2 flex-wrap gap-y-1">
            <h4 className="font-bold text-slate-100 text-xs sm:text-sm truncate max-w-[220px] xs:max-w-xs sm:max-w-md">
              {song.artistName} — {song.metadata?.title || song.basename}
            </h4>
            <span className="px-2 py-0.5 rounded-md text-[10px] font-mono bg-[#0F172A] text-slate-300 border border-slate-800">
              {song.ext.toUpperCase()}
            </span>
            {song.isComplete ? (
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[10px] sm:text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                COMPLETE
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[10px] sm:text-[11px] font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/20">
                <AlertCircle className="w-3 h-3 text-amber-400" />
                NEEDS SYNC
              </span>
            )}
          </div>

          <p className="text-[11px] sm:text-xs text-slate-400 font-mono truncate max-w-full sm:max-w-xl">
            {song.filePath}
          </p>

          {/* File Checklist Badges */}
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 pt-1 text-[10px] sm:text-[11px] font-mono">
            {/* Instrumental status */}
            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border ${
              song.hasInstrumental
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                : 'bg-red-500/10 border-red-500/20 text-red-400'
            }`}>
              <Music className="w-3 h-3" />
              <span>
                {song.hasInstrumental ? 'Instrumental: PRESENT' : 'Instrumental: MISSING'}
              </span>
            </div>

            {/* eLRC status */}
            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border ${
              song.hasElrc
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                : 'bg-red-500/10 border-red-500/20 text-red-400'
            }`}>
              <FileText className="w-3 h-3" />
              <span>
                {song.hasElrc ? '.elrc.lrc: PRESENT' : '.elrc.lrc: MISSING'}
              </span>
            </div>

            {/* Lyrics source indicator */}
            {song.metadata?.lyricsSource && song.metadata.lyricsSource !== 'none' && (
              <div className="flex items-center gap-1 px-2.5 py-1 rounded-lg border bg-[#FF4FA3]/10 border-[#FF4FA3]/20 text-pink-300 text-[10px]">
                <span>Lyrics: {song.metadata.lyricsSource}</span>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="grid grid-cols-3 sm:flex sm:items-center gap-2 sm:space-x-2.5 flex-shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-800/60">
          {/* Preview Audio */}
          <button
            onClick={() => onPreviewAudio(song.filePath, song.fileName)}
            className="flex items-center justify-center space-x-1.5 px-3 py-2 sm:py-1.5 rounded-xl bg-[#0F172A] hover:bg-slate-800 text-slate-300 text-xs font-medium border border-slate-800 transition min-h-[38px] sm:min-h-0"
            title="Preview Audio"
          >
            <Headphones className="w-3.5 h-3.5 text-[#FF4FA3]" />
            <span>Preview</span>
          </button>

          {/* View / Edit Lyrics */}
          <button
            onClick={() => onEditLyrics(song)}
            disabled={!isAdmin}
            className="flex items-center justify-center space-x-1.5 px-3 py-2 sm:py-1.5 rounded-xl bg-[#0F172A] hover:bg-slate-800 text-slate-300 text-xs font-medium border border-slate-800 transition min-h-[38px] sm:min-h-0 disabled:opacity-40"
            title={!isAdmin ? 'Administrator privileges required to edit companion lyrics' : 'View or Edit Lyrics'}
          >
            <FileEdit className="w-3.5 h-3.5 text-pink-400" />
            <span>Lyrics</span>
          </button>

          {/* Process / Reprocess */}
          <button
            onClick={() => onEnqueueSong(song.filePath, song.artistName)}
            className={`flex items-center justify-center space-x-1.5 px-3.5 py-2 sm:py-1.5 rounded-xl text-xs font-semibold transition min-h-[38px] sm:min-h-0 ${
              song.isComplete
                ? 'bg-[#0F172A] hover:bg-slate-800 text-slate-200 border border-slate-800'
                : 'bg-[#FF4FA3] hover:bg-[#ff3d99] text-white shadow-md shadow-[#FF4FA3]/20'
            }`}
          >
            <Play className="w-3 h-3" />
            <span>{song.isComplete ? 'Reprocess' : 'Process'}</span>
          </button>
        </div>
      </div>
    </div>
  );
});

SongCard.displayName = 'SongCard';

export interface VirtualizedSongListProps {
  songs: SongItem[];
  isAdmin: boolean;
  onPreviewAudio: (filePath: string, title: string) => void;
  onEditLyrics: (song: SongItem) => void;
  onEnqueueSong: (filePath: string, artistName: string) => void;
  itemHeight?: number;
  overscan?: number;
}

export const VirtualizedSongList: React.FC<VirtualizedSongListProps> = ({
  songs,
  isAdmin,
  onPreviewAudio,
  onEditLyrics,
  onEnqueueSong,
  itemHeight = 150,
  overscan = 5,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(650);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = () => {
      setScrollTop(el.scrollTop);
    };

    const handleResize = () => {
      if (el.clientHeight > 0) {
        setContainerHeight(el.clientHeight);
      }
    };

    handleResize();
    el.addEventListener('scroll', handleScroll, { passive: true });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(el);
    }

    return () => {
      el.removeEventListener('scroll', handleScroll);
      if (resizeObserver) resizeObserver.disconnect();
    };
  }, []);

  const totalHeight = songs.length * itemHeight;

  const { visibleSongs } = useMemo(() => {
    if (songs.length === 0) {
      return { startIndex: 0, endIndex: 0, visibleSongs: [] };
    }

    const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const end = Math.min(
      songs.length - 1,
      Math.ceil((scrollTop + containerHeight) / itemHeight) + overscan
    );

    const items = [];
    for (let i = start; i <= end; i++) {
      items.push({
        song: songs[i],
        top: i * itemHeight,
        index: i,
      });
    }

    return {
      startIndex: start,
      endIndex: end,
      visibleSongs: items,
    };
  }, [songs, scrollTop, containerHeight, itemHeight, overscan]);

  if (songs.length === 0) {
    return (
      <div className="p-12 text-center rounded-2xl bg-[#1E293B] border border-slate-800 text-xs text-slate-500">
        No songs found in this selection.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="virtualized-song-container"
      className="max-h-[680px] md:max-h-[720px] overflow-y-auto pr-1 space-y-0 relative rounded-2xl"
    >
      <div
        data-testid="virtualized-scroll-spacer"
        className="relative w-full"
        style={{ height: `${totalHeight}px` }}
      >
        {visibleSongs.map(({ song, top }) => (
          <div
            key={song.id || song.filePath}
            data-testid={`virtual-row-${song.id}`}
            className="absolute left-0 right-0 px-0.5"
            style={{
              top: `${top}px`,
              height: `${itemHeight - 12}px`,
            }}
          >
            <SongCard
              song={song}
              isAdmin={isAdmin}
              onPreviewAudio={onPreviewAudio}
              onEditLyrics={onEditLyrics}
              onEnqueueSong={onEnqueueSong}
            />
          </div>
        ))}
      </div>
    </div>
  );
};
