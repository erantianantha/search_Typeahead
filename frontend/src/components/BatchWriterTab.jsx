import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Layers, Clock, CheckCircle, XCircle, Database } from 'lucide-react';

const API = '/api';

const MOCK_STATUS = {
  queueSize: 12,
  isFlushing: false,
  totalFlushed: 47,
  totalWrites: 8320,
  flushIntervalMs: 10000,
  maxBatchSize: 1000,
  queueLimit: 10000,
  flushHistory: [
    { timestamp: new Date(Date.now() - 10000).toISOString(), batchSize: 186, uniqueQueries: 142, durationMs: 73,  status: 'success', retriesUsed: 0 },
    { timestamp: new Date(Date.now() - 20000).toISOString(), batchSize: 234, uniqueQueries: 178, durationMs: 89,  status: 'success', retriesUsed: 0 },
    { timestamp: new Date(Date.now() - 30000).toISOString(), batchSize: 98,  uniqueQueries: 76,  durationMs: 51,  status: 'success', retriesUsed: 0 },
    { timestamp: new Date(Date.now() - 40000).toISOString(), batchSize: 1000,uniqueQueries: 712, durationMs: 312, status: 'success', retriesUsed: 1 },
    { timestamp: new Date(Date.now() - 50000).toISOString(), batchSize: 312, uniqueQueries: 245, durationMs: 97,  status: 'failed',  retriesUsed: 3 },
  ],
};

function FlushRow({ entry }) {
  const ok = entry.status === 'success';
  const dedup = entry.batchSize > 0 ? Math.round((entry.uniqueQueries / entry.batchSize) * 100) : 0;
  return (
    <tr className="hover:bg-slate-800/30 transition-colors">
      <td className="table-cell font-mono text-xs text-slate-500">{new Date(entry.timestamp).toLocaleTimeString()}</td>
      <td className="table-cell"><span className="font-semibold text-white">{entry.batchSize}</span></td>
      <td className="table-cell"><span className="font-semibold text-slate-300">{entry.uniqueQueries}</span><span className="text-xs text-slate-600 ml-1">({dedup}%)</span></td>
      <td className="table-cell"><span className={`font-semibold ${entry.durationMs > 200 ? 'text-amber-400' : 'text-emerald-400'}`}>{entry.durationMs} ms</span></td>
      <td className="table-cell">
        <span className={`badge ${ok ? 'badge-green' : 'badge-red'}`}>
          {ok ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
          {entry.status}
        </span>
        {entry.retriesUsed > 0 && <span className="ml-2 text-xs text-amber-400">x{entry.retriesUsed} retries</span>}
      </td>
    </tr>
  );
}

function QueueMeter({ size, limit }) {
  const pct = Math.min(100, (size / limit) * 100);
  const color = pct > 80 ? '#A32D2D' : pct > 50 ? '#BA7517' : '#0F6E56';
  return (
    <div>
      <div className="flex justify-between text-xs mb-1.5">
        <span className="text-slate-400">Queue Occupancy</span>
        <span className="font-bold" style={{ color }}>{size.toLocaleString()} / {limit.toLocaleString()}</span>
      </div>
      <div className="h-3 bg-slate-800 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="flex justify-between text-xs text-slate-600 mt-1">
        <span>0</span><span>{pct.toFixed(1)}% full</span><span>{limit.toLocaleString()}</span>
      </div>
    </div>
  );
}

export default function BatchWriterTab() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/batch/status`);
      const data = await res.json();
      setStatus(data);
    } catch {
      setStatus(MOCK_STATUS);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchStatus, 3000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchStatus]);

  const s = status || MOCK_STATUS;
  const avgDuration = s.flushHistory?.length
    ? Math.round(s.flushHistory.reduce((a, b) => a + b.durationMs, 0) / s.flushHistory.length) : 0;
  const successRate = s.flushHistory?.length
    ? Math.round((s.flushHistory.filter(f => f.status === 'success').length / s.flushHistory.length) * 100) : 100;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-start justify-between mb-6 flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-2 mb-1">
            <Layers className="w-6 h-6 text-purple-400" />Batch Writer
          </h2>
          <p className="text-slate-400 text-sm">
            Async DB write queue -- flushes every <strong className="text-white">{s.flushIntervalMs / 1000}s</strong> or on <strong className="text-white">{s.maxBatchSize?.toLocaleString()}</strong> items.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <div className={`relative w-10 h-5 rounded-full transition-colors ${autoRefresh ? 'bg-brand-600' : 'bg-slate-700'}`} onClick={() => setAutoRefresh(p => !p)}>
              <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${autoRefresh ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </div>
            <span className="text-xs text-slate-400">Auto-refresh 3s</span>
          </label>
          <button id="batch-refresh-btn" onClick={fetchStatus} disabled={loading} className="btn-primary flex items-center gap-2 text-sm disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Queue Size',    value: s.queueSize?.toLocaleString(), icon: <Layers className="w-4 h-4" />,      color: s.queueSize > 500 ? 'text-red-400' : 'text-blue-400' },
          { label: 'Total Flushed', value: s.totalFlushed,                icon: <CheckCircle className="w-4 h-4" />, color: 'text-emerald-400' },
          { label: 'Total Writes',  value: s.totalWrites?.toLocaleString(),icon: <Database className="w-4 h-4" />,   color: 'text-teal-400' },
          { label: 'Avg Duration',  value: `${avgDuration} ms`,           icon: <Clock className="w-4 h-4" />,       color: avgDuration > 200 ? 'text-amber-400' : 'text-emerald-400' },
        ].map(item => (
          <div key={item.label} className="stat-card">
            <div className={`${item.color} mb-1`}>{item.icon}</div>
            <div className={`text-2xl font-bold ${item.color}`}>{item.value}</div>
            <div className="text-xs text-slate-500">{item.label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div className="glass-card p-5">
          <div className="section-title mb-4">Queue Meter</div>
          <QueueMeter size={s.queueSize || 0} limit={s.queueLimit || 10000} />
          <div className="mt-4 flex items-center gap-2 text-sm">
            {s.isFlushing
              ? <span className="flex items-center gap-2 text-blue-400"><RefreshCw className="w-4 h-4 animate-spin" />Flushing in progress...</span>
              : <span className="flex items-center gap-2 text-emerald-400"><CheckCircle className="w-4 h-4" />Idle -- next flush in ~{s.flushIntervalMs / 1000}s</span>
            }
          </div>
        </div>
        <div className="glass-card p-5">
          <div className="section-title mb-4">Configuration</div>
          <div className="space-y-2.5">
            {[
              { label: 'Flush Interval',  value: `${s.flushIntervalMs / 1000}s` },
              { label: 'Max Batch Size',  value: s.maxBatchSize?.toLocaleString() },
              { label: 'Queue Limit',     value: s.queueLimit?.toLocaleString() },
              { label: 'Success Rate',    value: `${successRate}%` },
              { label: 'Retry Strategy', value: '3x with exp. backoff' },
              { label: 'Dedup Strategy', value: 'Memory aggregation' },
            ].map(item => (
              <div key={item.label} className="flex items-center justify-between py-1.5 border-b border-slate-800/60 last:border-0">
                <span className="text-xs text-slate-500">{item.label}</span>
                <span className="font-mono text-xs text-slate-300 font-semibold">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="glass-card overflow-hidden mb-6">
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
          <div className="section-title">Flush History</div>
          <span className="text-xs text-slate-600">{s.flushHistory?.length || 0} records</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-slate-800">
              <tr>{['Timestamp', 'Batch Size', 'Unique Queries', 'Duration', 'Status'].map(h => <th key={h} className="table-header">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {(s.flushHistory || []).length === 0
                ? <tr><td colSpan={5} className="table-cell text-center py-8 text-slate-500">No flush events yet. Submit some searches to populate the batch queue.</td></tr>
                : (s.flushHistory || []).map((entry, i) => <FlushRow key={i} entry={entry} />)
              }
            </tbody>
          </table>
        </div>
      </div>

      <div className="glass-card p-6">
        <div className="section-title mb-4">Write Flow Architecture</div>
        <div className="font-mono text-xs text-slate-400 p-4 bg-slate-900/60 rounded-xl leading-relaxed">
          <span className="text-slate-600">-- Upsert SQL (batched)</span>{'\n'}
          <span className="text-blue-400">INSERT INTO</span> queries (query_text, count, last_searched_at, updated_at){'\n'}
          <span className="text-blue-400">VALUES</span> ($1, $2, NOW(), NOW()), ($3, $4, NOW(), NOW()), ...{'\n'}
          <span className="text-blue-400">ON CONFLICT</span> (query_text) <span className="text-blue-400">DO UPDATE SET</span>{'\n'}
          {'  '}count = queries.count + <span className="text-teal-400">EXCLUDED</span>.count,{'\n'}
          {'  '}last_searched_at = <span className="text-teal-400">EXCLUDED</span>.last_searched_at;
        </div>
      </div>
    </div>
  );
}
