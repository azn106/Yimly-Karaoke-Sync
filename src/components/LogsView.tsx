import React, { useState, useRef, useEffect } from 'react';
import { 
  Terminal, 
  Copy, 
  Check, 
  Trash2, 
  Search, 
  ArrowDownCircle, 
  Filter, 
  AlertTriangle, 
  Info, 
  AlertOctagon,
  Sparkles,
  Mic
} from 'lucide-react';
import { EngineLog } from '../types.js';

interface LogsViewProps {
  logs: EngineLog[];
  onClearLogs?: () => void;
}

export const LogsView: React.FC<LogsViewProps> = ({ logs, onClearLogs }) => {
  const [levelFilter, setLevelFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const filteredLogs = logs.filter(log => {
    if (levelFilter !== 'ALL' && log.level !== levelFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return log.message.toLowerCase().includes(q) || (log.jobId && log.jobId.toLowerCase().includes(q));
    }
    return true;
  });

  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'auto' });
    }
  }, [logs, autoScroll]);

  const handleCopyLogs = () => {
    const text = filteredLogs
      .map(l => `[${new Date(l.timestamp).toLocaleTimeString()}] [${l.level}] ${l.message}`)
      .join('\n');

    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getLogBadge = (level: EngineLog['level']) => {
    switch (level) {
      case 'ERR':
        return <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-red-500/15 text-red-400 border border-red-500/30">[ERR]</span>;
      case 'WARN':
        return <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30">[WARN]</span>;
      case 'SEG':
        return <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-blue-500/15 text-blue-400 border border-blue-500/30">[SEG]</span>;
      case 'WORD':
        return <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-500/15 text-indigo-400 border border-indigo-500/30">[WORD]</span>;
      case 'PROG':
        return <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">[PROG]</span>;
      default:
        return <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-[#0F172A] text-slate-400 border border-slate-800">[INFO]</span>;
    }
  };

  return (
    <div className="space-y-4">
      {/* Top Controls Bar */}
      <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3 p-3.5 sm:p-4 rounded-2xl bg-[#1E293B] border border-slate-800 shadow-sm">
        <div className="flex items-center space-x-3">
          <div className="p-2 rounded-xl bg-[#FF4FA3]/15 border border-[#FF4FA3]/30 text-[#FF4FA3] flex-shrink-0">
            <Terminal className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-xs sm:text-sm font-bold text-slate-100 truncate">Engine Logs & Output</h2>
            <span className="text-[11px] font-mono text-slate-400">{filteredLogs.length} events logged</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          {/* Level Filter */}
          <div className="flex items-center bg-[#0F172A] border border-slate-800 rounded-xl p-1 text-xs overflow-x-auto no-scrollbar">
            {['ALL', 'INFO', 'WARN', 'ERR', 'SEG', 'WORD'].map(lvl => (
              <button
                key={lvl}
                onClick={() => setLevelFilter(lvl)}
                className={`px-2.5 py-1 rounded-lg font-medium transition min-h-[30px] sm:min-h-0 ${
                  levelFilter === lvl
                    ? 'bg-[#FF4FA3]/20 text-[#FF4FA3] border border-[#FF4FA3]/30 font-semibold'
                    : 'text-slate-400 hover:text-slate-200 border border-transparent'
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>

          {/* Search */}
          <input
            type="text"
            placeholder="Search logs..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="flex-1 sm:flex-none px-3 py-1.5 bg-[#0F172A] border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-[#FF4FA3] min-w-[120px] sm:w-36 min-h-[34px] sm:min-h-0"
          />

          {/* Auto Scroll Toggle */}
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition flex items-center justify-center gap-1.5 min-h-[34px] sm:min-h-0 ${
              autoScroll
                ? 'bg-[#FF4FA3]/15 border-[#FF4FA3]/30 text-[#FF4FA3]'
                : 'bg-[#0F172A] border-slate-800 text-slate-400'
            }`}
          >
            <ArrowDownCircle className="w-3.5 h-3.5" />
            <span>Auto-scroll</span>
          </button>

          {/* Copy Button */}
          <button
            onClick={handleCopyLogs}
            className="flex items-center justify-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-[#0F172A] hover:bg-slate-800 text-slate-200 text-xs font-medium border border-slate-800 transition min-h-[34px] sm:min-h-0"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-slate-400" />}
            <span>{copied ? 'Copied!' : 'Copy'}</span>
          </button>
        </div>
      </div>

      {/* Terminal View Container */}
      <div className="rounded-2xl border border-slate-800 bg-[#0F172A] font-mono text-xs shadow-2xl overflow-hidden">
        {/* Terminal Header */}
        <div className="flex items-center justify-between px-5 py-3 bg-[#1E293B]/80 border-b border-slate-800 text-[11px] text-slate-400">
          <div className="flex items-center space-x-2">
            <div className="w-3 h-3 rounded-full bg-red-500/80" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
            <div className="w-3 h-3 rounded-full bg-green-500/80" />
            <span className="ml-3 text-slate-400 font-medium">split.py & align.py stdout / stderr stream</span>
          </div>
          <span className="text-slate-500 font-mono">UTF-8 / LF</span>
        </div>

        {/* Log Entries Stream */}
        <div className="p-5 max-h-[580px] overflow-y-auto space-y-1.5 select-text">
          {filteredLogs.length === 0 ? (
            <div className="text-slate-600 italic py-12 text-center">
              No log messages recorded yet.
            </div>
          ) : (
            filteredLogs.map((log) => {
              const dateStr = new Date(log.timestamp).toLocaleTimeString();
              const isErr = log.level === 'ERR';
              const isWarn = log.level === 'WARN';
              const isSeg = log.level === 'SEG';
              const isWord = log.level === 'WORD';

              return (
                <div
                  key={log.id}
                  className={`flex items-start space-x-2.5 py-1 leading-relaxed hover:bg-slate-800/40 rounded-lg px-2 ${
                    isErr ? 'bg-red-500/10 text-red-300' :
                    isWarn ? 'bg-amber-500/10 text-amber-300' :
                    isSeg ? 'text-blue-300' :
                    isWord ? 'text-indigo-300' : 'text-slate-300'
                  }`}
                >
                  <span className="text-slate-500 select-none text-[10px] whitespace-nowrap pt-0.5">
                    {dateStr}
                  </span>
                  <span className="flex-shrink-0">{getLogBadge(log.level)}</span>
                  <span className="break-all whitespace-pre-wrap flex-1">{log.message}</span>
                </div>
              );
            })
          )}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
};
