import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Database, Server, AlertCircle, CheckCircle } from 'lucide-react';

const API = '/api';
const NODE_COLORS = { A: '#0F6E56', B: '#185FA5', C: '#BA7517' };
const NODE_PORTS  = { A: 6379, B: 6380, C: 6381 };

const MOCK_ENTRIES = [
  { key: 'suggest:iph',   node: 'B', ttl: 245, cardinality: 10, status: 'HIT' },
  { key: 'suggest:best',  node: 'C', ttl: 301, cardinality: 10, status: 'HIT' },
  { key: 'suggest:py',    node: 'B', ttl: 42,  cardinality: 7,  status: 'HIT' },
  { key: 'suggest:react', node: 'A', ttl: 0,   cardinality: 0,  status: 'EXPIRED' },
];

function TtlBar({ ttl, max }) {
  const pct = Math.min(100, (ttl / (max || 300)) * 100);
  const color = pct > 50 ? '#0F6E56' : pct > 20 ? '#BA7517' : '#A32D2D';
  return (
    <div className="w-24 flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-xs font-mono text-slate-500 w-8 text-right">{ttl}s</span>
    </div>
  );
}

function NodeCard({ nodeId, entries }) {
  const color = NODE_COLORS[nodeId];
  const port  = NODE_PORTS[nodeId];
  const nodeEntries = entries.filter(e => e.node === nodeId);
  const hitRate = nodeEntries.length > 0
    ? Math.round((nodeEntries.filter(e => e.status === 'HIT').length / nodeEntries.length) * 100) : 0;
  return (
    <div className="glass-card-sm p-4" style={{ borderColor: color + '30' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white" style={{ background: color }}>{nodeId}</div>
          <div><div className="text-sm font-semibold text-white">Node {nodeId}</div><div className="text-xs font-mono text-slate-500">:{port}</div></div>
        </div>
        <div className="text-right"><div className="text-lg font-bold text-white">{nodeEntries.length}</div><div className="text-xs text-slate-500">keys</div></div>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{ width: `${hitRate}%`, background: color }} />
        </div>
        <span className="text-xs text-slate-400">{hitRate}% hit</span>
      </div>
    </div>
  );
}

export default function CacheMonitorTab() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lastScanned, setLastScanned] = useState(null);
  const [filter, setFilter] = useState('ALL');
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/cache/status`);
      const data = await res.json();
      setEntries(data.entries || []);
      setLastScanned(new Date(data.scannedAt));
    } catch {
      setEntries(MOCK_ENTRIES);
      setLastScanned(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchStatus, 5000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchStatus]);

  const filtered = filter === 'ALL' ? entries : entries.filter(e => e.status === filter || e.node === filter);
  const hitCount = entries.filter(e => e.status === 'HIT').length;
  const expiredCount = entries.filter(e => e.status === 'EXPIRED').length;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-start justify-between mb-6 flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white mb-1">Cache Monitor</h2>
          <p className="text-slate-400 text-sm">Live Redis ZSET keys across 3 nodes. Scans <code className="font-mono text-slate-300">suggest:*</code> prefix.</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <div className={`relative w-10 h-5 rounded-full transition-colors ${autoRefresh ? 'bg-brand-600' : 'bg-slate-700'}`} onClick={() => setAutoRefresh(p => !p)}>
              <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${autoRefresh ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </div>
            <span className="text-xs text-slate-400">Auto-refresh 5s</span>
          </label>
          <button id="cache-refresh-btn" onClick={fetchStatus} disabled={loading} className="btn-primary flex items-center gap-2 text-sm disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total Keys', value: entries.length, icon: <Database className="w-4 h-4" />, color: 'text-blue-400' },
          { label: 'Cache Hits',  value: hitCount,       icon: <CheckCircle className="w-4 h-4" />, color: 'text-emerald-400' },
          { label: 'Expired',     value: expiredCount,   icon: <AlertCircle className="w-4 h-4" />, color: 'text-amber-400' },
          { label: 'Nodes Up',    value: '3 / 3',        icon: <Server className="w-4 h-4" />, color: 'text-teal-400' },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <div className={`${s.color} mb-1`}>{s.icon}</div>
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-xs text-slate-500">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {['A', 'B', 'C'].map(n => <NodeCard key={n} nodeId={n} entries={entries} />)}
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {['ALL', 'HIT', 'EXPIRED', 'A', 'B', 'C'].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${filter === f ? 'bg-brand-600/30 text-brand-400 border border-brand-600/40' : 'bg-slate-800/50 text-slate-500 border border-slate-700/40 hover:text-slate-300'}`}>
            {['A','B','C'].includes(f) ? `Node ${f}` : f}
            {f !== 'ALL' && <span className="ml-1 opacity-60">({entries.filter(e => e.status === f || e.node === f).length})</span>}
          </button>
        ))}
        {lastScanned && <span className="ml-auto text-xs text-slate-600">Scanned at {lastScanned.toLocaleTimeString()}</span>}
      </div>

      <div className="glass-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-slate-800">
              <tr>{['Cache Key', 'Node', 'TTL', 'Entries', 'Status'].map(h => <th key={h} className="table-header">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filtered.length === 0 ? (
                <tr><td colSpan={5} className="table-cell text-center py-10 text-slate-500">{loading ? 'Scanning Redis nodes...' : 'No cache entries found.'}</td></tr>
              ) : filtered.map((e, i) => {
                const nc = NODE_COLORS[e.node] || '#60A5FA';
                return (
                  <tr key={i} className="hover:bg-slate-800/30 transition-colors">
                    <td className="table-cell"><code className="font-mono text-blue-400 text-xs">{e.key || `${e.node}: error`}</code></td>
                    <td className="table-cell">
                      <span className="flex items-center gap-1.5">
                        <span className="w-5 h-5 rounded-full text-xs font-bold text-white flex items-center justify-center" style={{ background: nc }}>{e.node}</span>
                        <span className="text-xs text-slate-500">:{NODE_PORTS[e.node]}</span>
                      </span>
                    </td>
                    <td className="table-cell">{e.ttl != null ? <TtlBar ttl={e.ttl} /> : <span className="text-slate-600">--</span>}</td>
                    <td className="table-cell"><span className="font-semibold text-slate-200">{e.cardinality ?? '--'}</span><span className="text-slate-600 text-xs ml-1">members</span></td>
                    <td className="table-cell"><span className={`badge ${e.status === 'HIT' ? 'badge-green' : e.status === 'EXPIRED' ? 'badge-red' : 'badge-amber'}`}>{e.status || 'UNKNOWN'}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
