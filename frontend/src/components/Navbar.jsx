import { useState, useEffect } from 'react';
import { Activity } from 'lucide-react';

export default function Navbar({ tabs, activeTab, onTabChange }) {
  const [scrolled, setScrolled] = useState(false);
  const [backendAlive, setBackendAlive] = useState(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const check = async () => {
      try {
        const apiBase = import.meta.env.VITE_API_URL || '/api';
        const res = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(3000) });
        setBackendAlive(res.ok);
      } catch {
        setBackendAlive(false);
      }
    };
    check();
    const id = setInterval(check, 15000);
    return () => clearInterval(id);
  }, []);

  return (
    <header
      className={`fixed top-0 inset-x-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'bg-slate-950/90 backdrop-blur-md border-b border-slate-700/50 shadow-xl shadow-black/20'
          : 'bg-slate-950/70 backdrop-blur-sm border-b border-slate-800/50'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-6">
        {/* Logo */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-2xl">⚡</span>
          <span className="font-extrabold text-xl tracking-tight bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
            SearchQL
          </span>
          <span className="hidden sm:block text-[10px] font-semibold text-slate-500 uppercase tracking-widest mt-0.5 ml-1">
            HLD Demo
          </span>
        </div>

        {/* Tab Nav */}
        <nav className="flex items-center gap-1 overflow-x-auto scrollbar-none">
          {tabs.map(tab => (
            <button
              key={tab.id}
              id={`tab-${tab.id}`}
              onClick={() => onTabChange(tab.id)}
              className={`flex items-center gap-1.5 px-3 sm:px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition-all duration-200 ${
                activeTab === tab.id
                  ? 'bg-brand-600/20 text-brand-400 border border-brand-600/30 shadow-sm shadow-brand-600/10'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <span className="text-base leading-none">{tab.emoji}</span>
              <span className="hidden sm:block">{tab.label}</span>
            </button>
          ))}
        </nav>

        {/* Status badge */}
        <div className="shrink-0 flex items-center gap-2">
          <Activity className="w-3.5 h-3.5 text-slate-500" />
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <span
              className={`w-2 h-2 rounded-full ${
                backendAlive === null ? 'bg-slate-500 animate-pulse' :
                backendAlive ? 'bg-emerald-400 animate-pulse-slow' : 'bg-red-500'
              }`}
            />
            <span className={
              backendAlive === null ? 'text-slate-500' :
              backendAlive ? 'text-emerald-400' : 'text-red-400'
            }>
              {backendAlive === null ? 'Connecting…' : backendAlive ? 'API Live' : 'Offline'}
            </span>
          </span>
        </div>
      </div>
    </header>
  );
}
