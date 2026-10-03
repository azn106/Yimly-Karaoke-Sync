import React, { useState } from 'react';
import { Lock, User, ShieldCheck, LogIn, AlertCircle } from 'lucide-react';

interface AuthModalProps {
  isSetup: boolean;
  onAuthSuccess: () => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({ isSetup, onAuthSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!username.trim() || !password) {
      setError('Please enter both username and password.');
      return;
    }

    if (isSetup && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);

    const endpoint = isSetup ? '/api/auth/setup' : '/api/auth/login';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || 'Authentication failed. Please try again.');
        return;
      }

      onAuthSuccess();
    } catch (err: any) {
      setError(err.message || 'Network error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0F172A]/90 backdrop-blur-md p-4">
      <div className="w-full max-w-md p-6 sm:p-8 rounded-2xl bg-[#1E293B] border border-slate-800 shadow-2xl space-y-6 animate-in fade-in zoom-in duration-200">
        <div className="text-center space-y-2">
          <div className="mx-auto w-12 h-12 rounded-2xl bg-[#FF4FA3]/10 border border-[#FF4FA3]/20 flex items-center justify-center text-[#FF4FA3]">
            {isSetup ? <ShieldCheck className="w-6 h-6" /> : <Lock className="w-6 h-6" />}
          </div>
          <h2 className="text-lg font-bold text-slate-100">
            {isSetup ? 'Create Admin Account' : 'Welcome to Yimly Sync'}
          </h2>
          <p className="text-xs text-slate-400">
            {isSetup
              ? 'Set up your local administrator account to manage karaoke synchronization.'
              : 'Sign in to access your karaoke library and processing status.'}
          </p>
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-slate-300">
              Username
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-500 absolute left-3 top-3" />
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full pl-9 pr-3.5 py-2.5 bg-[#0F172A] border border-slate-800 rounded-xl text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-[#FF4FA3]"
                placeholder="e.g. admin"
                autoFocus
                required
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-slate-300">
              Password
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-500 absolute left-3 top-3" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-9 pr-3.5 py-2.5 bg-[#0F172A] border border-slate-800 rounded-xl text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-[#FF4FA3]"
                placeholder="••••••••"
                required
              />
            </div>
          </div>

          {isSetup && (
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-300">
                Confirm Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-500 absolute left-3 top-3" />
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full pl-9 pr-3.5 py-2.5 bg-[#0F172A] border border-slate-800 rounded-xl text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-[#FF4FA3]"
                  placeholder="••••••••"
                  required
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-2 py-2.5 px-4 rounded-xl bg-[#FF4FA3] hover:bg-[#ff3d99] text-white text-xs font-bold shadow-lg shadow-[#FF4FA3]/25 transition active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? (
              <span>Processing...</span>
            ) : (
              <>
                <LogIn className="w-4 h-4" />
                <span>{isSetup ? 'Create Administrator' : 'Sign In'}</span>
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
