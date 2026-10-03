import React from 'react';
import { 
  Activity, 
  FolderTree, 
  Terminal, 
  Settings as SettingsIcon, 
  Cpu, 
  Zap,
  Music2,
  HardDrive,
  Radio,
  Pause,
  Play,
  X
} from 'lucide-react';
import { SystemStatus, AppSettings } from '../types.js';

interface SidebarProps {
  status: SystemStatus | null;
  settings: AppSettings | null;
  currentTab: 'queue' | 'library' | 'logs' | 'settings' | 'diagnostics';
  onTabChange: (tab: 'queue' | 'library' | 'logs' | 'settings' | 'diagnostics') => void;
  onToggleMonitoring: () => void;
  isMobileOpen?: boolean;
  onCloseMobile?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  status,
  settings,
  currentTab,
  onTabChange,
  onToggleMonitoring,
  isMobileOpen = false,
  onCloseMobile,
}) => {
  const isMonitoring = status?.monitoring ?? false;
  const cudaAvailable = status?.pythonInfo?.cudaAvailable ?? false;
  const gpuName = status?.pythonInfo?.deviceName || (cudaAvailable ? 'CUDA Acceleration' : 'CPU Mode');

  const navItems = [
    {
      id: 'queue' as const,
      label: 'Processing Queue',
      icon: Activity,
      badge: status?.queuedJobs ? status.queuedJobs : null,
      badgeColor: 'bg-[#FF4FA3]/20 text-[#FF4FA3] border-[#FF4FA3]/30',
    },
    {
      id: 'library' as const,
      label: 'Music Library',
      icon: FolderTree,
      badge: status?.totalSongs ? `${status.completedSongs}/${status.totalSongs}` : null,
      badgeColor: 'bg-slate-800 text-slate-300 border-slate-700',
    },
    {
      id: 'logs' as const,
      label: 'Live Engine Logs',
      icon: Terminal,
      badge: null,
      badgeColor: '',
    },
    {
      id: 'settings' as const,
      label: 'Engine Settings',
      icon: SettingsIcon,
      badge: null,
      badgeColor: '',
    },
    {
      id: 'diagnostics' as const,
      label: 'Diagnostics',
      icon: Cpu,
      badge: null,
      badgeColor: '',
    },
  ];

  const renderContent = (isMobileView = false) => (
    <div className="flex flex-col h-full justify-between select-none">
      {/* Brand & Navigation */}
      <div className="flex flex-col">
        {/* Brand Header */}
        <div className="p-6 border-b border-slate-800/80 flex items-center justify-between">
          <div className="flex items-center gap-3.5">
            <div className="w-9 h-9 bg-[#FF4FA3] rounded-xl flex items-center justify-center shadow-lg shadow-[#FF4FA3]/25 text-white flex-shrink-0">
              <Music2 className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold text-slate-100 tracking-tight flex items-center gap-2">
                <span>Yimly Sync</span>
                <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-[#FF4FA3]/15 text-[#FF4FA3] border border-[#FF4FA3]/25">
                  v1.2
                </span>
              </h1>
              <p className="text-xs text-slate-400 truncate">Demucs + WhisperX Monitor</p>
            </div>
          </div>

          {isMobileView && onCloseMobile && (
            <button
              onClick={onCloseMobile}
              className="w-10 h-10 -mr-2 rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-100 hover:bg-slate-800/80 transition"
              aria-label="Close navigation menu"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Navigation Section */}
        <div className="p-4 space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 px-3 pb-2 pt-1">
            Navigation
          </div>
          {navItems.map(item => {
            const Icon = item.icon;
            const isActive = currentTab === item.id;

            return (
              <button
                key={item.id}
                onClick={() => {
                  onTabChange(item.id);
                  if (isMobileView && onCloseMobile) {
                    onCloseMobile();
                  }
                }}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-medium transition-all min-h-[44px] sm:min-h-0 ${
                  isActive
                    ? 'bg-[#FF4FA3]/15 text-[#FF4FA3] border border-[#FF4FA3]/30 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Icon className={`w-4 h-4 ${isActive ? 'text-[#FF4FA3]' : 'text-slate-400'}`} />
                  <span>{item.label}</span>
                </div>
                {item.badge && (
                  <span className={`px-2 py-0.5 rounded-md text-[10px] font-mono border ${item.badgeColor}`}>
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Bottom Status & Hardware Cards */}
      <div className="p-4 border-t border-slate-800 space-y-3 bg-[#1E293B]">
        {/* Monitoring State Card */}
        <div className="p-3.5 rounded-xl bg-[#0F172A]/80 border border-slate-800 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Monitoring Service
            </span>
            <span className={`px-2 py-0.5 rounded text-[10px] font-bold border flex items-center gap-1.5 ${
              isMonitoring
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : 'bg-slate-800 text-slate-400 border-slate-700'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${isMonitoring ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
              <span>{isMonitoring ? 'ACTIVE' : 'IDLE'}</span>
            </span>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-300">
            <span className="text-[11px] text-slate-400">Auto-detect files</span>
            <button
              onClick={onToggleMonitoring}
              className={`text-[11px] font-semibold px-2.5 py-1.5 rounded transition min-h-[36px] sm:min-h-0 flex items-center ${
                isMonitoring
                  ? 'text-red-400 hover:bg-red-500/10'
                  : 'text-[#FF4FA3] hover:bg-[#FF4FA3]/10'
              }`}
            >
              {isMonitoring ? 'Stop' : 'Start'}
            </button>
          </div>
        </div>

        {/* Hardware Status Card */}
        <div className="p-3 rounded-xl bg-[#0F172A]/80 border border-slate-800 flex items-center gap-3">
          <div className={`p-2 rounded-lg border ${
            cudaAvailable
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
              : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
          }`}>
            <Zap className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] text-slate-400 uppercase tracking-tight font-medium">
              Execution Device
            </div>
            <div className="text-xs font-semibold text-slate-200 truncate">
              {gpuName}
            </div>
            {status?.pythonInfo?.vramGb ? (
              <div className="text-[10px] text-[#FF4FA3] font-mono">
                {status.pythonInfo.vramGb} GB VRAM Available
              </div>
            ) : (
              <div className="text-[10px] text-slate-500">
                {cudaAvailable ? 'PyTorch CUDA Ready' : 'PyTorch CPU Engine'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Persistent Sidebar (Unchanged on md: and larger) */}
      <aside className="hidden md:flex w-72 bg-[#1E293B] border-r border-slate-800 flex-col flex-shrink-0 select-none h-screen justify-between">
        {renderContent(false)}
      </aside>

      {/* Mobile Drawer (Only visible on < md when opened) */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          {/* Backdrop */}
          <div 
            className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
            onClick={onCloseMobile}
          />

          {/* Drawer panel */}
          <aside className="relative w-4/5 max-w-xs bg-[#1E293B] border-r border-slate-800 h-full flex flex-col shadow-2xl z-10 animate-in slide-in-from-left duration-200">
            {renderContent(true)}
          </aside>
        </div>
      )}
    </>
  );
};
