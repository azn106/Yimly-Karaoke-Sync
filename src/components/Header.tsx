import React from 'react';
import { 
  Play, 
  Pause, 
  RefreshCw,
  HardDrive,
  Menu,
  Music2
} from 'lucide-react';
import { SystemStatus, AppSettings } from '../types.js';

interface HeaderProps {
  status: SystemStatus | null;
  settings: AppSettings | null;
  onToggleMonitoring: () => void;
  onTogglePauseQueue: () => void;
  onRescan: () => void;
  isScanning: boolean;
  onOpenMobileMenu?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  status,
  settings,
  onToggleMonitoring,
  onTogglePauseQueue,
  onRescan,
  isScanning,
  onOpenMobileMenu,
}) => {
  const isMonitoring = status?.monitoring ?? false;
  const isPaused = status?.queuePaused ?? false;

  return (
    <header className="h-16 border-b border-slate-800 flex items-center justify-between px-3.5 sm:px-6 lg:px-8 bg-[#0F172A] flex-shrink-0 select-none z-10">
      {/* Left: Mobile Menu Trigger + Watching Path Breadcrumb */}
      <div className="flex items-center space-x-2.5 sm:space-x-3 min-w-0">
        {/* Mobile Hamburger Button */}
        {onOpenMobileMenu && (
          <button
            onClick={onOpenMobileMenu}
            className="md:hidden flex items-center justify-center w-10 h-10 rounded-xl bg-[#1E293B] border border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800 transition active:scale-95 flex-shrink-0"
            aria-label="Open navigation menu"
          >
            <Menu className="w-5 h-5" />
          </button>
        )}

        {/* Mobile Brand Logo Icon */}
        <div className="md:hidden flex items-center gap-1.5 flex-shrink-0">
          <div className="w-7 h-7 bg-[#FF4FA3] rounded-lg flex items-center justify-center shadow shadow-[#FF4FA3]/20 text-white">
            <Music2 className="w-4 h-4" />
          </div>
        </div>

        {/* Watching Path */}
        <div className="flex items-center space-x-1.5 sm:space-x-2 px-2.5 sm:px-3 py-1.5 rounded-lg bg-[#1E293B] border border-slate-800 text-xs min-w-0">
          <HardDrive className="w-3.5 h-3.5 text-[#FF4FA3] flex-shrink-0" />
          <span className="text-slate-400 hidden sm:inline">Watching:</span>
          <span className="font-mono font-medium text-slate-200 truncate max-w-[100px] xs:max-w-[140px] sm:max-w-[220px] md:max-w-none">
            {settings?.mediaRoot || '/media'}
          </span>
        </div>

        {isScanning && (
          <div className="hidden lg:flex items-center space-x-1.5 px-2.5 py-1 rounded-md bg-[#FF4FA3]/10 text-[#FF4FA3] border border-[#FF4FA3]/20 text-xs animate-pulse flex-shrink-0">
            <RefreshCw className="w-3 h-3 animate-spin" />
            <span>Scanning directory...</span>
          </div>
        )}
      </div>

      {/* Right: Quick Action Controls */}
      <div className="flex items-center space-x-1.5 sm:space-x-3 flex-shrink-0">
        {/* Quick Rescan */}
        <button
          onClick={onRescan}
          disabled={isScanning}
          className="flex items-center space-x-1.5 sm:space-x-2 px-2.5 sm:px-3.5 py-2 rounded-xl bg-[#1E293B] hover:bg-slate-800 text-slate-200 text-xs font-medium border border-slate-800 transition-all disabled:opacity-50 shadow-sm active:scale-95 min-h-[38px]"
          title="Scan library folder for new or incomplete songs"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin text-[#FF4FA3]' : 'text-slate-400'}`} />
          <span className="hidden sm:inline">{isScanning ? 'Scanning...' : 'Scan /media'}</span>
          <span className="sm:hidden">{isScanning ? '...' : 'Scan'}</span>
        </button>

        {/* Queue Pause / Resume */}
        <button
          onClick={onTogglePauseQueue}
          className={`flex items-center space-x-1.5 sm:space-x-2 px-2.5 sm:px-3.5 py-2 rounded-xl text-xs font-medium border transition-all shadow-sm active:scale-95 min-h-[38px] ${
            isPaused
              ? 'bg-amber-500/10 border-amber-500/20 text-amber-300 hover:bg-amber-500/20'
              : 'bg-[#1E293B] hover:bg-slate-800 border-slate-800 text-slate-200'
          }`}
          title={isPaused ? 'Resume processing queue' : 'Pause processing queue'}
        >
          {isPaused ? <Play className="w-3.5 h-3.5 text-amber-400" /> : <Pause className="w-3.5 h-3.5 text-slate-400" />}
          <span className="hidden sm:inline">{isPaused ? 'Resume Queue' : 'Pause Queue'}</span>
          <span className="sm:hidden">{isPaused ? 'Resume' : 'Pause'}</span>
        </button>

        {/* Monitor Start / Stop */}
        <button
          onClick={onToggleMonitoring}
          className={`flex items-center space-x-1.5 sm:space-x-2 px-3 sm:px-4 py-2 rounded-xl text-xs font-semibold border transition-all shadow-lg active:scale-95 min-h-[38px] ${
            isMonitoring
              ? 'bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20 shadow-red-500/10'
              : 'bg-[#FF4FA3] hover:bg-[#ff3d99] border-[#FF4FA3] text-white shadow-[#FF4FA3]/25'
          }`}
        >
          {isMonitoring ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">{isMonitoring ? 'Stop Monitor' : 'Start Monitor'}</span>
          <span className="sm:hidden">{isMonitoring ? 'Stop' : 'Start'}</span>
        </button>
      </div>
    </header>
  );
};
