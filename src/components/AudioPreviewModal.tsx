import React from 'react';
import { X, Headphones, Music } from 'lucide-react';

interface AudioPreviewModalProps {
  filePath: string | null;
  title: string;
  onClose: () => void;
}

export const AudioPreviewModal: React.FC<AudioPreviewModalProps> = ({
  filePath,
  title,
  onClose,
}) => {
  if (!filePath) return null;

  const audioUrl = `/api/audio?path=${encodeURIComponent(filePath)}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-[#0F172A]/80 backdrop-blur-md">
      <div className="bg-[#1E293B] border border-slate-800 rounded-3xl w-full max-w-lg overflow-hidden shadow-2xl space-y-4 p-4 sm:p-7 animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center space-x-3 sm:space-x-3.5 min-w-0">
            <div className="p-2.5 sm:p-3 rounded-2xl bg-[#FF4FA3]/15 border border-[#FF4FA3]/30 text-[#FF4FA3] flex-shrink-0">
              <Headphones className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm sm:text-base font-bold text-slate-100 truncate max-w-[200px] xs:max-w-xs">
                {title}
              </h3>
              <p className="text-[11px] sm:text-xs text-slate-400 font-mono truncate max-w-[200px] xs:max-w-xs mt-0.5">
                {filePath}
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

        <div className="p-4 sm:p-5 rounded-2xl bg-[#0F172A] border border-slate-800 flex flex-col items-center justify-center space-y-3 shadow-inner">
          <Music className="w-8 h-8 text-[#FF4FA3] animate-pulse" />
          <audio
            controls
            autoPlay
            src={audioUrl}
            className="w-full h-10 accent-[#FF4FA3]"
          />
        </div>

        <div className="flex justify-end pt-2">
          <button
            onClick={onClose}
            className="w-full sm:w-auto px-5 py-2.5 sm:py-2 rounded-xl bg-[#0F172A] hover:bg-slate-800 text-slate-200 text-xs font-medium transition border border-slate-800 text-center"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
