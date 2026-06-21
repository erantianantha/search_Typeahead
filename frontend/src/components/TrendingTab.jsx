import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, TrendingUp, Flame } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from 'recharts';

const API = '/api';

const MOCK_TRENDING = [
  { rank: 1, query: 'best restaurants in manali', score: 98.5, count: 5842 },
  { rank: 2, query: 'iphone 15 pro max review',  score: 94.2, count: 5310 },
  { rank: 3, query: 'python tutorial for beginners', score: 89.7, count: 4870 },
  { rank: 4, query: 'wireless earbuds under 50',  score: 84.1, count: 4450 },
  { rank: 5, query: 'react js hooks tutorial',    score: 80.3, count: 4120 },
  { rank: 6, query: 'gaming laptop 2024',         score: 75.8, count: 3780 },
  { rank: 7, query: 'machine learning projects',  score: 71.2, count: 3340 },
  { rank: 8, query: 'weight loss tips at home',   score: 66.5, count: 2980 },
  { rank: 9, query: 'best noise cancelling headphones', score: 61.9, count: 2640 },
  { rank: 10, query: 'how to learn typescript',   score: 57.3, count: 2300 },
];

const SCORE_GRADIENT = ['#185FA5','#1E7CB0','#2499BB','#2AB5C6','#30D0D1','#36D88A','#3CD05A','#72C84B','#A8C03C','#D4B82D'];

const CustomTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-slate-900 border border-slate-700/60 rounded-xl px-4 py-3 shadow-xl text-sm">
      <div className="font-semibold text-white mb-1 max-w-xs truncate">{d.query}</div>
      <div className="text-blue-400">Score: <strong>{d.score?.toFixed(1)}</strong></div>
      <div className="text-slate-400">Count: {d.count?.toLocaleString()}</div>
    </div>
  );
};

function RankMedal({ rank }) {
  if (rank === 1) return <span className="text-yellow-400 text-lg">Gold</span>;
  if (rank === 2) return <span className="text-slate-400 text-lg">Silver</span>;
  if (rank === 3) return <span className="text-amber-600 text-lg">Bronze</span>;
  return <span className="w-7 h-7 rounded-full bg-slate-800 text-slate-500 text-xs font-bold flex items-center justify-center">{rank}</span>;
}

export default function TrendingTab() {
  const [trending, setTrending] = useState([]);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [view, setView] = useState('leaderboard');

  const fetchTrending = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/trending?limit=10`);
      const data = await res.json();
      if (data.trending?.length) { setTrending(data.trending); setUpdatedAt(new Date(data.updatedAt)); }
      else setTrending(MOCK_TRENDING);
    } catch {
      setTrending(MOCK_TRENDING);
      setUpdatedAt(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTrending(); }, [fetchTrending]);

  const maxScore = Math.max(...trending.map(t => t.score), 1);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-start justify-between mb-6 flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-2 mb-1">
            <Flame className="w-6 h-6 text-coral-500" />Trending Queries
          </h2>
          <p className="text-slate-400 text-sm">Score = <code className="font-mono text-slate-300 text-xs">0.7 * total_count + 0.3 * recency_score</code>, updated every 30s.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-slate-900/60 border border-slate-700/40 rounded-xl p-1">
            {['leaderboard', 'chart'].map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-all ${view === v ? 'bg-brand-600/30 text-brand-400' : 'text-slate-500 hover:text-slate-300'}`}>
                {v === 'leaderboard' ? 'Leaderboard' : 'Chart'}
              </button>
            ))}
          </div>
          <button id="trending-refresh-btn" onClick={fetchTrending} disabled={loading} className="btn-primary flex items-center gap-2 text-sm disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Refresh
          </button>
        </div>
      </div>

      {trending.length >= 3 && (
        <div className="grid grid-cols-3 gap-3 mb-6">
          {[trending[1], trending[0], trending[2]].map((item, i) => {
            const isGold = item.rank === 1;
            return (
              <div key={item.rank} className={`glass-card p-4 text-center ${isGold ? 'border-yellow-500/30' : ''} ${i === 1 ? '-mt-3' : 'mt-3'}`}>
                <div className="flex justify-center mb-2"><RankMedal rank={item.rank} /></div>
                <div className="text-xs text-slate-300 font-medium leading-snug mb-2 line-clamp-2">{item.query}</div>
                <div className={`text-xl font-extrabold ${isGold ? 'text-yellow-400' : 'text-slate-200'}`}>{item.score?.toFixed(1)}</div>
                <div className="text-xs text-slate-500">score</div>
              </div>
            );
          })}
        </div>
      )}

      {view === 'leaderboard' ? (
        <div className="glass-card overflow-hidden">
          <div className="divide-y divide-slate-800/60">
            {trending.map((item, i) => {
              const barWidth = (item.score / maxScore) * 100;
              const color = SCORE_GRADIENT[i] || '#185FA5';
              return (
                <div key={item.rank} className="flex items-center gap-4 px-5 py-3.5 hover:bg-slate-800/30 transition-colors relative overflow-hidden">
                  <div className="absolute left-0 top-0 h-full opacity-5 transition-all duration-700" style={{ width: `${barWidth}%`, background: color }} />
                  <div className="flex items-center justify-center w-7 shrink-0 relative"><RankMedal rank={item.rank} /></div>
                  <div className="flex-1 min-w-0 relative">
                    <div className="text-sm font-medium text-slate-200 truncate">{item.query}</div>
                    <div className="text-xs text-slate-600 mt-0.5">{item.count?.toLocaleString() ?? '--'} searches</div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 relative">
                    <div className="w-28 hidden sm:flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${barWidth}%`, background: color }} />
                      </div>
                    </div>
                    <div className="text-sm font-bold" style={{ color }}>{item.score?.toFixed(1)}</div>
                    {item.rank <= 3 && <TrendingUp className="w-4 h-4 text-coral-500" />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="glass-card p-6">
          <div className="section-title mb-4">Score Distribution</div>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={trending} margin={{ top: 5, right: 10, left: 0, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="query" tick={{ fill: '#64748b', fontSize: 10 }} angle={-35} textAnchor="end" interval={0} />
              <YAxis tick={{ fill: '#64748b', fontSize: 11 }} />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: '#ffffff08' }} />
              <Bar dataKey="score" radius={[6, 6, 0, 0]}>
                {trending.map((_, i) => <Cell key={i} fill={SCORE_GRADIENT[i] || '#185FA5'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="mt-6 glass-card p-6">
        <div className="section-title mb-3">Scoring Formula</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { title: 'Total Count (70%)', desc: 'All-time search frequency from PostgreSQL queries table.' },
            { title: 'Recency Score (30%)', desc: 'Sum of hourly Redis ZSET buckets from the past 24h, boosting recent surges.' },
            { title: 'Update Frequency', desc: 'Background cron runs every 30 seconds, updating all query scores.' },
          ].map(item => (
            <div key={item.title} className="glass-card-sm p-4">
              <div className="text-sm font-semibold text-white mb-1">{item.title}</div>
              <div className="text-xs text-slate-500 leading-relaxed">{item.desc}</div>
            </div>
          ))}
        </div>
        <div className="mt-4 font-mono text-sm text-center text-slate-400 py-3 bg-slate-900/60 rounded-xl">
          score = <span className="text-blue-400">0.7</span> * total_count + <span className="text-teal-400">0.3</span> * recency_last_24h
        </div>
        {updatedAt && <div className="mt-3 text-xs text-slate-600 text-center">Last updated: {updatedAt.toLocaleTimeString()}</div>}
      </div>
    </div>
  );
}
