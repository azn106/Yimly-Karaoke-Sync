/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Sidebar } from './components/Sidebar.js';
import { Header } from './components/Header.js';
import { QueueView } from './components/QueueView.js';
import { LibraryView } from './components/LibraryView.js';
import { LogsView } from './components/LogsView.js';
import { SettingsView } from './components/SettingsView.js';
import { DiagnosticsView } from './components/DiagnosticsView.js';
import { LyricsModal } from './components/LyricsModal.js';
import { AudioPreviewModal } from './components/AudioPreviewModal.js';
import { AuthModal } from './components/AuthModal.js';
import { 
  Layers, 
  FolderTree, 
  Terminal, 
  Settings as SettingsIcon, 
  Cpu 
} from 'lucide-react';
import { 
  SystemStatus, 
  AppSettings, 
  SongItem, 
  SyncJob, 
  EngineLog,
  AuthUser
} from './types.js';

export default function App() {
  const [currentTab, setCurrentTab] = useState<'queue' | 'library' | 'logs' | 'settings' | 'diagnostics'>('queue');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  // Local Authentication State
  const [authState, setAuthState] = useState<{
    loading: boolean;
    authenticated: boolean;
    needsSetup: boolean;
    user: AuthUser | null;
  }>({
    loading: true,
    authenticated: false,
    needsSetup: false,
    user: null,
  });

  const checkAuthStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      if (data.authenticated && data.user) {
        setAuthState({
          loading: false,
          authenticated: true,
          needsSetup: false,
          user: data.user,
        });
      } else {
        setAuthState({
          loading: false,
          authenticated: false,
          needsSetup: Boolean(data.needsSetup),
          user: null,
        });
      }
    } catch (err) {
      console.error('Error checking auth status:', err);
      setAuthState({
        loading: false,
        authenticated: false,
        needsSetup: false,
        user: null,
      });
    }
  }, []);

  useEffect(() => {
    checkAuthStatus();
  }, [checkAuthStatus]);

  useEffect(() => {
    if (settings && !settings.isConfigured && currentTab !== 'settings') {
      setCurrentTab('settings');
    }
  }, [settings, currentTab]);
  const [songs, setSongs] = useState<SongItem[]>([]);
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [activeJob, setActiveJob] = useState<SyncJob | null>(null);
  const [logs, setLogs] = useState<EngineLog[]>([]);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isRefreshingDiag, setIsRefreshingDiag] = useState<boolean>(false);

  // Modals state
  const [selectedLyricsSong, setSelectedLyricsSong] = useState<SongItem | null>(null);
  const [previewAudio, setPreviewAudio] = useState<{ path: string; title: string } | null>(null);

  // Fetch initial data
  const fetchAllData = useCallback(async () => {
    if (!authState.authenticated) return;
    try {
      const [statusRes, songsRes, queueRes, logsRes, settingsRes] = await Promise.all([
        fetch('/api/status').then(r => r.json()),
        fetch('/api/songs').then(r => r.json()),
        fetch('/api/queue').then(r => r.json()),
        fetch('/api/logs').then(r => r.json()),
        fetch('/api/settings').then(r => r.json()),
      ]);

      if (statusRes.status) setStatus(statusRes.status);
      if (songsRes.songs) setSongs(songsRes.songs);
      if (queueRes.jobs) setJobs(queueRes.jobs);
      if (queueRes.activeJob) setActiveJob(queueRes.activeJob);
      if (logsRes.logs) setLogs(logsRes.logs);
      if (settingsRes.settings) setSettings(settingsRes.settings);
    } catch (err) {
      console.error('Error fetching initial data:', err);
    }
  }, [authState.authenticated]);

  useEffect(() => {
    if (!authState.authenticated) return;

    fetchAllData();

    // Setup Server-Sent Events (SSE) for real-time live events
    const eventSource = new EventSource('/api/events');

    eventSource.addEventListener('init', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (data.status) setStatus(data.status);
        if (data.jobs) {
          setJobs(data.jobs);
          const active = data.jobs.find((j: SyncJob) => j.status === 'PROCESSING') || null;
          setActiveJob(active);
        }
        if (data.logs) setLogs(data.logs);
      } catch (err) {
        console.error('SSE Init parse error:', err);
      }
    });

    eventSource.addEventListener('job_updated', (e: MessageEvent) => {
      try {
        const updatedJob: SyncJob = JSON.parse(e.data);
        setJobs(prevJobs => {
          const index = prevJobs.findIndex(j => j.id === updatedJob.id);
          let newJobs;
          if (index !== -1) {
            newJobs = [...prevJobs];
            newJobs[index] = updatedJob;
          } else {
            newJobs = [...prevJobs, updatedJob];
          }
          const active = newJobs.find(j => j.status === 'PROCESSING') || null;
          setActiveJob(active);
          return newJobs;
        });

        // If job completed, trigger song list refresh
        if (updatedJob.status === 'COMPLETE' || updatedJob.status === 'FAILED') {
          fetch('/api/songs').then(r => r.json()).then(res => {
            if (res.songs) setSongs(res.songs);
          }).catch(() => {});
        }
      } catch (err) {
        console.error('SSE Job update error:', err);
      }
    });

    eventSource.addEventListener('job_removed', (e: MessageEvent) => {
      try {
        const { id } = JSON.parse(e.data);
        setJobs(prev => prev.filter(j => j.id !== id));
      } catch {}
    });

    eventSource.addEventListener('queue_cleared', () => {
      setJobs(prev => prev.filter(j => j.status !== 'COMPLETE' && j.status !== 'SKIPPED'));
    });

    eventSource.addEventListener('log', (e: MessageEvent) => {
      try {
        const logItem: EngineLog = JSON.parse(e.data);
        setLogs(prev => [...prev.slice(-900), logItem]);
      } catch {}
    });

    eventSource.addEventListener('logs_batch', (e: MessageEvent) => {
      try {
        const batch: EngineLog[] = JSON.parse(e.data);
        setLogs(prev => [...prev.slice(-900 + batch.length), ...batch]);
      } catch {}
    });

    eventSource.addEventListener('status_changed', (e: MessageEvent) => {
      try {
        const newStatus = JSON.parse(e.data);
        setStatus(prev => prev ? { ...prev, ...newStatus } : newStatus);
      } catch {}
    });

    return () => {
      eventSource.close();
    };
  }, [authState.authenticated, fetchAllData]);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    setAuthState({
      loading: false,
      authenticated: false,
      needsSetup: false,
      user: null,
    });
  };

  // Handlers
  const handleToggleMonitoring = async () => {
    if (!status) return;
    const endpoint = status.monitoring ? '/api/monitor/stop' : '/api/monitor/start';
    await fetch(endpoint, { method: 'POST' });
    fetchAllData();
  };

  const handleTogglePauseQueue = async () => {
    if (!status) return;
    const endpoint = status.queuePaused ? '/api/queue/resume' : '/api/queue/pause';
    await fetch(endpoint, { method: 'POST' });
    fetchAllData();
  };

  const handleRescan = async () => {
    setIsScanning(true);
    try {
      await fetch('/api/monitor/scan', { method: 'POST' });
      await fetchAllData();
    } finally {
      setIsScanning(false);
    }
  };

  const handleRetryFailed = async () => {
    await fetch('/api/queue/retry-failed', { method: 'POST' });
    fetchAllData();
  };

  const handleRetryJob = async (jobId: string) => {
    await fetch(`/api/queue/retry/${encodeURIComponent(jobId)}`, { method: 'POST' });
    fetchAllData();
  };

  const handleClearCompleted = async () => {
    await fetch('/api/queue/clear-completed', { method: 'POST' });
    fetchAllData();
  };

  const handleRemoveJob = async (jobId: string) => {
    await fetch(`/api/queue/remove/${encodeURIComponent(jobId)}`, { method: 'POST' });
    fetchAllData();
  };

  const handleEnqueueSong = async (filePath: string, artistName: string) => {
    await fetch('/api/queue/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, artistName }),
    });
    fetchAllData();
  };

  const handleProcessAllIncomplete = async () => {
    await fetch('/api/queue/process-all-incomplete', { method: 'POST' });
    fetchAllData();
  };

  const handleAddSampleSong = async () => {
    const samples = [
      { artist: 'Taylor Swift', title: 'Cruel Summer' },
      { artist: 'Billie Eilish', title: 'Bad Guy' },
      { artist: 'Dua Lipa', title: 'Levitating' },
      { artist: 'Coldplay', title: 'Viva La Vida' },
    ];
    const picked = samples[Math.floor(Math.random() * samples.length)];
    await fetch('/api/library/add-sample', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(picked),
    });
    // Rescan library
    setTimeout(() => handleRescan(), 800);
  };

  const handleSaveSettings = async (newSettings: Partial<AppSettings>) => {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSettings),
    }).then(r => r.json());

    if (res.settings) {
      setSettings(res.settings);
    }
    fetchAllData();
  };

  const handleSaveLyrics = async (filePath: string, lyrics: string) => {
    await fetch('/api/library/save-lyrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, lyrics }),
    });
    fetchAllData();
  };

  const handleRefreshDiagnostics = async () => {
    setIsRefreshingDiag(true);
    try {
      const diagRes = await fetch('/api/diagnostics').then(r => r.json());
      if (status && diagRes) {
        setStatus({
          ...status,
          pythonInfo: diagRes.python,
          ffmpegInfo: diagRes.ffmpeg,
        });
      }
    } finally {
      setIsRefreshingDiag(false);
    }
  };

  const activeJobsCount = jobs.filter(j => j.status === 'PROCESSING' || j.status === 'QUEUED' || j.status === 'WAITING_FOR_FILE').length;

  if (authState.loading) {
    return (
      <div className="flex h-screen w-screen bg-[#0F172A] text-slate-100 items-center justify-center font-sans">
        <div className="flex flex-col items-center space-y-4">
          <div className="w-10 h-10 border-4 border-[#FF4FA3] border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-slate-400 font-mono">Verifying local session security...</p>
        </div>
      </div>
    );
  }

  if (!authState.authenticated) {
    return (
      <AuthModal
        isSetup={authState.needsSetup}
        onAuthSuccess={checkAuthStatus}
      />
    );
  }

  return (
    <div className="flex h-screen w-screen bg-[#0F172A] text-slate-100 font-sans overflow-hidden select-none">
      {/* Sleek Sidebar (Desktop Persistent + Mobile Drawer) */}
      <Sidebar
        status={status}
        settings={settings}
        currentTab={currentTab}
        onTabChange={(tab) => {
          setCurrentTab(tab);
          setIsMobileMenuOpen(false);
        }}
        onToggleMonitoring={handleToggleMonitoring}
        isMobileOpen={isMobileMenuOpen}
        onCloseMobile={() => setIsMobileMenuOpen(false)}
        user={authState.user}
        onLogout={handleLogout}
      />

      {/* Main Content Column */}
      <div className="flex-1 flex flex-col overflow-hidden bg-[#0F172A]">
        {/* Sleek Topbar Header */}
        <Header
          status={status}
          settings={settings}
          onToggleMonitoring={handleToggleMonitoring}
          onTogglePauseQueue={handleTogglePauseQueue}
          onRescan={handleRescan}
          isScanning={isScanning}
          onOpenMobileMenu={() => setIsMobileMenuOpen(true)}
          userRole={authState.user?.role}
        />

        {/* Scrollable View Content */}
        <main className="flex-1 p-3.5 sm:p-6 lg:p-8 overflow-y-auto pb-24 md:pb-8">
          <div className="max-w-7xl mx-auto w-full">
            {currentTab === 'queue' && (
              <QueueView
                jobs={jobs}
                activeJob={activeJob}
                onRetryFailed={handleRetryFailed}
                onRetryJob={handleRetryJob}
                onClearCompleted={handleClearCompleted}
                onRemoveJob={handleRemoveJob}
                onProcessAllIncomplete={handleProcessAllIncomplete}
                onAddSampleSong={handleAddSampleSong}
                userRole={authState.user?.role}
              />
            )}

            {currentTab === 'library' && (
              <LibraryView
                songs={songs}
                onEnqueueSong={handleEnqueueSong}
                onRefreshLibrary={handleRescan}
                onPreviewAudio={(filePath, title) => setPreviewAudio({ path: filePath, title })}
                onEditLyrics={(song) => setSelectedLyricsSong(song)}
                userRole={authState.user?.role}
              />
            )}

            {currentTab === 'logs' && (
              <LogsView
                logs={logs}
                onClearLogs={() => setLogs([])}
              />
            )}

            {currentTab === 'settings' && (
              <SettingsView
                settings={settings}
                status={status}
                onSaveSettings={handleSaveSettings}
                userRole={authState.user?.role}
              />
            )}

            {currentTab === 'diagnostics' && (
              <DiagnosticsView
                status={status}
                onRefreshDiagnostics={handleRefreshDiagnostics}
                isRefreshing={isRefreshingDiag}
              />
            )}
          </div>
        </main>
      </div>

      {/* Mobile Bottom Navigation Bar (md:hidden) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#1E293B]/95 backdrop-blur-lg border-t border-slate-800 flex items-center justify-around py-1.5 px-2">
        <button
          onClick={() => setCurrentTab('queue')}
          className={`flex flex-col items-center justify-center py-1 px-2 rounded-xl transition min-w-[56px] min-h-[44px] ${
            currentTab === 'queue'
              ? 'text-[#FF4FA3]'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <div className="relative">
            <Layers className="w-5 h-5" />
            {activeJobsCount > 0 && (
              <span className="absolute -top-1 -right-2 w-4 h-4 rounded-full bg-[#FF4FA3] text-white text-[9px] font-bold flex items-center justify-center">
                {activeJobsCount}
              </span>
            )}
          </div>
          <span className="text-[10px] font-medium mt-0.5">Queue</span>
        </button>

        <button
          onClick={() => setCurrentTab('library')}
          className={`flex flex-col items-center justify-center py-1 px-2 rounded-xl transition min-w-[56px] min-h-[44px] ${
            currentTab === 'library'
              ? 'text-[#FF4FA3]'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <FolderTree className="w-5 h-5" />
          <span className="text-[10px] font-medium mt-0.5">Library</span>
        </button>

        <button
          onClick={() => setCurrentTab('logs')}
          className={`flex flex-col items-center justify-center py-1 px-2 rounded-xl transition min-w-[56px] min-h-[44px] ${
            currentTab === 'logs'
              ? 'text-[#FF4FA3]'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Terminal className="w-5 h-5" />
          <span className="text-[10px] font-medium mt-0.5">Logs</span>
        </button>

        <button
          onClick={() => setCurrentTab('settings')}
          className={`flex flex-col items-center justify-center py-1 px-2 rounded-xl transition min-w-[56px] min-h-[44px] ${
            currentTab === 'settings'
              ? 'text-[#FF4FA3]'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <SettingsIcon className="w-5 h-5" />
          <span className="text-[10px] font-medium mt-0.5">Settings</span>
        </button>

        <button
          onClick={() => setCurrentTab('diagnostics')}
          className={`flex flex-col items-center justify-center py-1 px-2 rounded-xl transition min-w-[56px] min-h-[44px] ${
            currentTab === 'diagnostics'
              ? 'text-[#FF4FA3]'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Cpu className="w-5 h-5" />
          <span className="text-[10px] font-medium mt-0.5">Diag</span>
        </button>
      </nav>

      {/* Modals */}
      {selectedLyricsSong && (
        <LyricsModal
          song={selectedLyricsSong}
          onClose={() => setSelectedLyricsSong(null)}
          onSaveLyrics={handleSaveLyrics}
        />
      )}

      {previewAudio && (
        <AudioPreviewModal
          filePath={previewAudio.path}
          title={previewAudio.title}
          onClose={() => setPreviewAudio(null)}
        />
      )}
    </div>
  );
}
