import React, { useState } from 'react';
import { 
  FolderTree, 
  Music, 
  FileAudio, 
  FileText, 
  CheckCircle2, 
  AlertCircle, 
  Play, 
  FileEdit, 
  Search, 
  RefreshCw,
  Headphones,
  CheckCircle,
  Clock
} from 'lucide-react';
import { SongItem } from '../types.js';

interface LibraryViewProps {
  songs: SongItem[];
  onEnqueueSong: (filePath: string, artistName: string) => void;
  onRefreshLibrary: () => void;
  onPreviewAudio: (filePath: string, title: string) => void;
  onEditLyrics: (song: SongItem) => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  songs,
  onEnqueueSong,
  onRefreshLibrary,
  onPreviewAudio,
  onEditLyrics,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedArtist, setSelectedArtist] = useState<string>('ALL');

  // Group songs by Artist
  const artistsMap = new Map<string, SongItem[]>();
  for (const s of songs) {
    const artist = s.artistName || 'Unknown Artist';
    if (!artistsMap.has(artist)) {
      artistsMap.set(artist, []);
    }
    artistsMap.get(artist)!.push(s);
  }

  const artistList = Array.from(artistsMap.keys()).sort();

  const filteredSongs = songs.filter(s => {
    if (selectedArtist !== 'ALL' && s.artistName !== selectedArtist) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        s.fileName.toLowerCase().includes(q) ||
        s.artistName.toLowerCase().includes(q) ||
        (s.metadata?.title && s.metadata.title.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const totalComplete = songs.filter(s => s.isComplete).length;
  const totalIncomplete = songs.length - totalComplete;

  return (
    <div className="space-y-6">
      {/* Top Header & Search */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3.5 sm:gap-4 p-4 sm:p-5 rounded-2xl bg-[#1E293B] border border-slate-800 shadow-sm">
        <div>
          <h2 className="text-sm sm:text-base font-bold text-slate-100 flex items-center gap-2.5">
            <FolderTree className="w-5 h-5 text-[#FF4FA3] flex-shrink-0" />
            <span>Yimly Music Library (<code className="text-[#FF4FA3] font-mono text-xs">/media</code>)</span>
          </h2>
          <p className="text-[11px] sm:text-xs text-slate-400 mt-1">
            Pipeline: Existing instrumental detection & Demucs generation + Musixmatch Richsync (<code className="text-[#FF4FA3] font-mono">.elrc.lrc</code>) and Subtitles (<code className="text-[#FF4FA3] font-mono">.lrc</code>).
          </p>
        </div>

        <div className="flex items-center space-x-2.5 w-full sm:w-auto flex-shrink-0">
          <div className="relative flex-1 sm:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search artists or tracks..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3.5 py-2.5 sm:py-2 bg-[#0F172A] border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-[#FF4FA3]"
            />
          </div>
          <button
            onClick={onRefreshLibrary}
            className="p-2.5 rounded-xl bg-[#0F172A] hover:bg-slate-800 text-slate-300 border border-slate-800 transition shadow-sm min-w-[40px] min-h-[40px] flex items-center justify-center flex-shrink-0"
            title="Refresh Library"
          >
            <RefreshCw className="w-4 h-4 text-slate-400" />
          </button>
        </div>
      </div>

      {/* Main Split Layout: Artist Sidebar & Tracks Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 sm:gap-6">
        {/* Artist Filter List */}
        <div className="md:col-span-1 space-y-2.5 sm:space-y-3">
          <div className="flex items-center justify-between px-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Artists ({artistList.length})
            </h3>
            <span className="text-[11px] font-mono text-slate-500">
              {totalComplete}/{songs.length} done
            </span>
          </div>

          <div className="bg-[#1E293B] border border-slate-800 rounded-2xl p-2 sm:p-2.5 max-h-[220px] md:max-h-[550px] overflow-y-auto space-y-1 shadow-sm">
            <button
              onClick={() => setSelectedArtist('ALL')}
              className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-medium transition flex items-center justify-between min-h-[38px] sm:min-h-0 ${
                selectedArtist === 'ALL'
                  ? 'bg-[#FF4FA3]/15 text-[#FF4FA3] border border-[#FF4FA3]/30 font-semibold'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 border border-transparent'
              }`}
            >
              <span>All Artists</span>
              <span className="text-[10px] font-mono text-slate-400 bg-[#0F172A] px-2 py-0.5 rounded-md border border-slate-800">
                {songs.length}
              </span>
            </button>
            {artistList.map(artist => {
              const artistSongs = artistsMap.get(artist) || [];
              const completeCount = artistSongs.filter(s => s.isComplete).length;
              const isSelected = selectedArtist === artist;

              return (
                <button
                  key={artist}
                  onClick={() => setSelectedArtist(artist)}
                  className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-medium transition flex items-center justify-between min-h-[38px] sm:min-h-0 ${
                    isSelected
                      ? 'bg-[#FF4FA3]/15 text-[#FF4FA3] border border-[#FF4FA3]/30 font-semibold'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 border border-transparent'
                  }`}
                >
                  <span className="truncate pr-1">{artist}</span>
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md border flex-shrink-0 ${
                    completeCount === artistSongs.length
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                      : 'bg-[#0F172A] text-slate-400 border-slate-800'
                  }`}>
                    {completeCount}/{artistSongs.length}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Songs List */}
        <div className="md:col-span-3 space-y-3">
          {filteredSongs.length === 0 ? (
            <div className="p-12 text-center rounded-2xl bg-[#1E293B] border border-slate-800 text-xs text-slate-500">
              No songs found in this selection.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:gap-3.5">
              {filteredSongs.map(song => (
                <div
                  key={song.id}
                  className={`p-3.5 sm:p-5 rounded-2xl border transition shadow-md ${
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
                        className="flex items-center justify-center space-x-1.5 px-3 py-2 sm:py-1.5 rounded-xl bg-[#0F172A] hover:bg-slate-800 text-slate-300 text-xs font-medium border border-slate-800 transition min-h-[38px] sm:min-h-0"
                        title="View or Edit Lyrics"
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
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
