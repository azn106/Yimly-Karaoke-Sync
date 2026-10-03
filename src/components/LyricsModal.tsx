import React, { useState, useEffect } from 'react';
import { X, FileText, Save, Check, AlertCircle } from 'lucide-react';
import { SongItem } from '../types.js';

interface LyricsModalProps {
  song: SongItem | null;
  onClose: () => void;
  onSaveLyrics: (filePath: string, lyrics: string) => Promise<void>;
}

export const LyricsModal: React.FC<LyricsModalProps> = ({
  song,
  onClose,
  onSaveLyrics,
}) => {
  const [lyricsText, setLyricsText] = useState<string>('');
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [savedSuccess, setSavedSuccess] = useState<boolean>(false);

  useEffect(() => {
    if (song) {
      setLyricsText(song.metadata?.lyricsPreview || '');
    }
  }, [song]);

  if (!song) return null;

  const handleSave = async () => {
    if (!song) return;
    setIsSaving(true);
    try {
      await onSaveLyrics(song.filePath, lyricsText);
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2000);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-[#0F172A]/80 backdrop-blur-md">
      <div className="bg-[#1E293B] border border-slate-800 rounded-3xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden shadow-2xl space-y-4 p-4 sm:p-7 animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center space-x-3 sm:space-x-3.5 min-w-0">
            <div className="p-2.5 sm:p-3 rounded-2xl bg-[#FF4FA3]/15 border border-[#FF4FA3]/30 text-[#FF4FA3] flex-shrink-0">
              <FileText className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm sm:text-base font-bold text-slate-100 truncate">
                Lyrics for {song.artistName} — {song.metadata?.title || song.basename}
              </h3>
              <p className="text-[11px] sm:text-xs text-slate-400 font-mono mt-0.5 truncate">
                Companion source: <code className="text-pink-300">{song.basename}.lrc</code> or <code className="text-pink-300">{song.basename}.txt</code>
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-[#0F172A] text-slate-400 hover:text-slate-200 transition flex-shrink-0 min-w-[36px] min-h-[36px] flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Note */}
        <div className="p-3 sm:p-3.5 rounded-xl bg-[#FF4FA3]/10 border border-[#FF4FA3]/20 text-[11px] sm:text-xs text-pink-200 flex items-center gap-2.5">
          <AlertCircle className="w-4 h-4 text-[#FF4FA3] flex-shrink-0" />
          <span>
            UserSync requires real lyrics for Needleman-Wunsch forced alignment. Plain text or standard LRC lines work perfectly.
          </span>
        </div>

        {/* Text Area */}
        <div className="space-y-1.5 flex-1 min-h-0 flex flex-col">
          <label className="block text-xs font-semibold text-slate-300">
            Lyrics Content:
          </label>
          <textarea
            value={lyricsText}
            onChange={e => setLyricsText(e.target.value)}
            rows={8}
            placeholder="Paste or edit the song lyrics here..."
            className="w-full p-3.5 sm:p-4 bg-[#0F172A] border border-slate-800 rounded-2xl text-xs font-mono text-slate-200 focus:outline-none focus:border-[#FF4FA3] leading-relaxed resize-none flex-1 min-h-[140px]"
          />
        </div>

        {/* Footer */}
        <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-3 border-t border-slate-800">
          <span className="text-[11px] font-mono text-slate-500 text-center sm:text-left">
            {lyricsText.trim().split('\n').filter(Boolean).length} lines | {lyricsText.length} characters
          </span>

          <div className="grid grid-cols-2 sm:flex items-center gap-2 sm:space-x-2.5">
            <button
              onClick={onClose}
              className="px-4 py-2.5 sm:py-2 rounded-xl bg-[#0F172A] hover:bg-slate-800 text-slate-300 text-xs font-medium transition border border-slate-800 text-center"
            >
              Close
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center justify-center space-x-2 px-4 py-2.5 sm:py-2 rounded-xl bg-[#FF4FA3] hover:bg-[#ff3d99] text-white text-xs font-semibold shadow-lg shadow-[#FF4FA3]/25 transition disabled:opacity-50 text-center"
            >
              {savedSuccess ? (
                <>
                  <Check className="w-4 h-4 text-emerald-300" />
                  <span>Saved!</span>
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  <span>{isSaving ? 'Saving...' : 'Save Lyrics'}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
