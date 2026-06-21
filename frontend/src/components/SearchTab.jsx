import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, TrendingUp, Zap, Clock, CheckCircle, X } from 'lucide-react';
import HashRingTab from './HashRingTab.jsx';

const API = '/api';

const TRENDING_MOCK = [
  'iphone 15 pro max', 'best gaming laptop 2024', 'python tutorial', 'react hooks guide',
  'wireless earbuds under 50',
];

function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export default function SearchTab({ onQueryChange }) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [cacheHit, setCacheHit] = useState(null);
  const [responseMs, setResponseMs] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dropOpen, setDropOpen] = useState(false);
  const [trending, setTrending] = useState(TRENDING_MOCK);
  const [searchResult, setSearchResult] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef(null);
  const debouncedQuery = useDebounce(query, 220);

  useEffect(() => {
    fetch(`${API}/trending?limit=5`)
      .then(r => r.json())
      .then(d => { if (d.trending?.length) setTrending(d.trending.map(t => t.query)); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!debouncedQuery.trim() || debouncedQuery.length < 3) {
      setSuggestions([]);
      setDropOpen(false);
      setCacheHit(null);
      setResponseMs(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    fetch(`${API}/suggest?q=${encodeURIComponent(debouncedQuery)}`, { signal: ctrl.signal })
      .then(r => {
        setCacheHit(r.headers.get('X-Cache') === 'HIT');
        setResponseMs(r.headers.get('X-Response-Time-Ms'));
        return r.json();
      })
      .then(data => {
        const sug = (data.suggestions || []).filter(s => s.query !== '__empty__');
        setSuggestions(sug);
        setDropOpen(sug.length > 0);
        setSelectedIdx(-1);
        onQueryChange?.(debouncedQuery);
      })
      .catch(err => { if (err.name !== 'AbortError') setSuggestions([]); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [debouncedQuery, onQueryChange]);

  const handleSearch = useCallback(async (q) => {
    const term = (q || query).trim();
    if (!term) return;
    setDropOpen(false);
    setSearchResult({ status: 'loading', query: term });
    try {
      const r = await fetch(`${API}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: term }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setSearchResult({ ...data, status: 'done' });
    } catch (err) {
      console.error('Search error:', err);
      setSearchResult({ status: 'error', query: term, message: err.message });
    }
  }, [query]);

  const handleKeyDown = (e) => {
    if (!dropOpen) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, -1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIdx >= 0) { setQuery(suggestions[selectedIdx].query); handleSearch(suggestions[selectedIdx].query); }
      else handleSearch();
    } else if (e.key === 'Escape') setDropOpen(false);
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-12">
      <div className="text-center mb-10">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-brand-600/10 border border-brand-600/20 text-brand-400 text-xs font-semibold mb-5">
          <Zap className="w-3.5 h-3.5" />
          Distributed Search Typeahead &middot; Redis Consistent Hashing
        </div>
        <h1 className="text-4xl sm:text-5xl font-extrabold text-white mb-3 tracking-tight">Search Anything</h1>
        <p className="text-slate-400 text-lg">Powered by PostgreSQL + 3-node Redis cluster with consistent hashing</p>
      </div>

      <div className="relative">
        <div className={`flex items-center gap-2 bg-slate-900/80 border rounded-2xl px-4 shadow-2xl transition-all duration-300 ${dropOpen ? 'border-brand-500/60 ring-2 ring-brand-500/20 rounded-b-none' : 'border-slate-700/60 hover:border-slate-600'}`}>
          <Search className={`w-5 h-5 shrink-0 transition-colors ${loading ? 'text-brand-400 animate-pulse' : 'text-slate-500'}`} />
          <input
            ref={inputRef}
            id="search-input"
            type="text"
            className="flex-1 bg-transparent text-white placeholder-slate-500 py-4 text-lg outline-none font-medium"
            placeholder="Type to search... e.g. iphone 15"
            value={query}
            onChange={e => { setQuery(e.target.value); setSearchResult(null); }}
            onKeyDown={handleKeyDown}
            onFocus={() => suggestions.length > 0 && setDropOpen(true)}
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button onClick={() => { setQuery(''); setSuggestions([]); setDropOpen(false); setSearchResult(null); inputRef.current?.focus(); }} className="text-slate-500 hover:text-slate-300 transition-colors p-1">
              <X className="w-4 h-4" />
            </button>
          )}
          <button id="search-btn" onClick={() => handleSearch()} disabled={!query.trim()} className="btn-primary shrink-0 flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed">
            <Search className="w-4 h-4" /><span>Search</span>
          </button>
        </div>

        {dropOpen && suggestions.length > 0 && (
          <div className="absolute inset-x-0 top-full bg-slate-900 border border-brand-500/40 border-t-0 rounded-b-2xl shadow-2xl z-40 overflow-hidden animate-fade-in">
            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/80">
              <div className="flex items-center gap-3">
                <span className={`badge ${cacheHit ? 'badge-green' : 'badge-amber'}`}>{cacheHit ? 'Cache HIT' : 'Cache MISS'}</span>
                {responseMs && <span className="flex items-center gap-1 text-xs text-slate-500"><Clock className="w-3 h-3" />{responseMs} ms</span>}
              </div>
              <span className="text-xs text-slate-600">{suggestions.length} results</span>
            </div>
            {suggestions.map((s, i) => (
              <button key={s.query} id={`suggestion-${i}`}
                className={`suggestion-item w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${i === selectedIdx ? 'bg-brand-600/20' : 'hover:bg-slate-800/60'} ${i < suggestions.length - 1 ? 'border-b border-slate-800/50' : ''}`}
                onClick={() => { setQuery(s.query); handleSearch(s.query); }}>
                <Search className="suggestion-icon w-4 h-4 text-slate-600 shrink-0 transition-colors" />
                <span className="flex-1 text-sm text-slate-200">{s.query}</span>
                <div className="flex items-center gap-2 shrink-0">
                  {s.score > 80 && <span className="tag-trending"><TrendingUp className="w-3 h-3" /> Trending</span>}
                  <span className="mono text-xs text-slate-600">{s.count !== undefined ? `${s.count.toLocaleString()} searches` : s.score?.toFixed(1)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Trending Now</span>
        {trending.map((t, i) => (
          <button key={i} id={`trending-chip-${i}`} className="tag-trending" onClick={() => { setQuery(t); handleSearch(t); }}>{t}</button>
        ))}
      </div>

      {searchResult && (
        <div className="mt-8 glass-card p-6 animate-slide-down">
          {searchResult.status === 'loading' ? (
            <div className="flex items-center gap-3 text-slate-400">
              <div className="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              <span className="font-medium">Searching for "{searchResult.query}"...</span>
            </div>
          ) : searchResult.status === 'done' ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle className="w-5 h-5 text-emerald-400" />
                <span className="font-semibold text-white text-lg">{searchResult.status}</span>
                <span className="badge badge-green">Queued for DB write</span>
              </div>
              <p className="text-slate-400 text-sm">Query <span className="text-white font-medium">"{searchResult.query}"</span> processed and enqueued for count update.</p>
              <div className="grid grid-cols-3 gap-3 pt-2">
                {[
                  { label: 'Queue Size', value: searchResult.queue_size ?? '--', color: 'text-blue-400' },
                  { label: 'Status', value: searchResult.queued ? 'Enqueued' : 'Rejected', color: searchResult.queued ? 'text-emerald-400' : 'text-red-400' },
                  { label: 'Time', value: new Date(searchResult.timestamp).toLocaleTimeString(), color: 'text-slate-300' },
                ].map(item => (
                  <div key={item.label} className="glass-card-sm px-4 py-3">
                    <div className="text-xs text-slate-500 mb-1">{item.label}</div>
                    <div className={`font-semibold ${item.color}`}>{item.value}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-red-400">
                <X className="w-5 h-5" />
                <span>Search failed — backend may be offline.</span>
              </div>
              {searchResult.message && <div className="mono text-xs text-slate-600 pl-7">{searchResult.message}</div>}
            </div>
          )}
        </div>
      )}

      <div className="mt-12 grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { emoji: 'lightning', title: 'Sub-10ms Responses', desc: 'Suggestions served from Redis ZSET cache on cache hits, DB on misses.' },
          { emoji: 'shuffle', title: 'Consistent Hashing', desc: '3-node Redis ring with MD5 Ketama -- trace the key routing in real-time below.' },
          { emoji: 'package', title: 'Batch DB Writes', desc: 'Searches queue up and flush to PostgreSQL every 10s or on 1000 item threshold.' },
        ].map(card => (
          <div key={card.title} className="stat-card">
            <div className="font-semibold text-white text-sm">{card.title}</div>
            <div className="text-xs text-slate-500 leading-relaxed mt-1">{card.desc}</div>
          </div>
        ))}
      </div>

      <div className="mt-16 border-t border-slate-800/60 pt-10">
        <HashRingTab currentQuery={debouncedQuery} />
      </div>
    </div>
  );
}
