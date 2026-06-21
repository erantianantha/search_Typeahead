import { useState, useEffect, useCallback, useMemo } from 'react';
import { AlertTriangle, RefreshCw, Info, Server, HelpCircle, Shield, CheckCircle } from 'lucide-react';

const API = '/api';
const CX = 250, CY = 250, R = 180;
const MAX_UINT32 = 4294967296;

const NODE_COLORS = { A: '#10B981', B: '#3B82F6', C: '#F59E0B' }; // Emerald, Blue, Amber
const NODE_BG_COLORS = { A: 'rgba(16,185,129,0.1)', B: 'rgba(59,130,246,0.1)', C: 'rgba(245,158,11,0.1)' };
const NODE_PORTS = { A: 6379, B: 6380, C: 6381 };

function ringToSVG(angleDeg, r) {
  const rad = (angleDeg - 90) * Math.PI / 180;
  return { x: CX + (r || R) * Math.cos(rad), y: CY + (r || R) * Math.sin(rad) };
}

function getSweepingArcPath(startAngle, endAngle, r) {
  let diff = endAngle - startAngle;
  if (diff < 0) diff += 360;
  
  if (Math.abs(diff) < 0.2) return ''; 

  const radius = r || R;
  const s = ringToSVG(startAngle, radius);
  const e = ringToSVG(endAngle, radius);
  
  const large = diff > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

function generateMockVnodes() {
  const mock = [];
  const nodes = ['A', 'B', 'C'];
  for (let i = 0; i < 480; i++) {
    const rawPosition = Math.floor((i / 480) * MAX_UINT32) + Math.floor(Math.random() * (MAX_UINT32 / 480));
    const position = Math.round((rawPosition / MAX_UINT32) * 360);
    const node = nodes[i % 3];
    mock.push({
      rawPosition,
      position,
      node,
      address: node === 'A' ? '127.0.0.1:6379' : node === 'B' ? '127.0.0.1:6380' : '127.0.0.1:6381'
    });
  }
  return mock.sort((a, b) => a.rawPosition - b.rawPosition);
}

export default function HashRingTab({ currentQuery }) {
  const [vnodes, setVnodes] = useState(() => generateMockVnodes());
  const [loadingVnodes, setLoadingVnodes] = useState(true);
  const [nodesError, setNodesError] = useState(null);
  const [traceData, setTraceData] = useState(null);
  const [failedNode, setFailedNode] = useState(null);
  const [isTracing, setIsTracing] = useState(false);
  const [visibleStepCount, setVisibleStepCount] = useState(0);

  // Sync with App-level query if passed
  useEffect(() => {
    if (currentQuery && currentQuery.trim()) {
      runTrace(currentQuery);
    } else {
      setTraceData(null);
    }
  }, [currentQuery]);

  // Fetch real ring nodes on mount
  const fetchRingNodes = useCallback(async () => {
    try {
      setLoadingVnodes(true);
      const res = await fetch(`${API}/ring/nodes`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data = await res.json();
      if (data && Array.isArray(data.positions)) {
        setVnodes(data.positions);
        setNodesError(null);
      }
    } catch (err) {
      console.warn('Failed to load ring nodes, using mock:', err.message);
      setNodesError(err.message);
    } finally {
      setLoadingVnodes(false);
    }
  }, []);

  useEffect(() => {
    fetchRingNodes();
  }, [fetchRingNodes]);

  const runTrace = useCallback(async (q) => {
    const term = q;
    if (!term || !term.trim()) return;
    setIsTracing(true);
    setVisibleStepCount(0);
    try {
      const res = await fetch(`${API}/ring/trace?q=${encodeURIComponent(term)}`);
      if (!res.ok) throw new Error('Trace API error');
      const data = await res.json();
      setTraceData(data);
    } catch (err) {
      console.error('Failed to trace route:', err);
      // Client-side local trace simulation fallback
      let h = 5381;
      const cleanTerm = `suggest:${term.toLowerCase().replace(/[^a-z0-9 ]/g, '')}`;
      for (let i = 0; i < cleanTerm.length; i++) {
        h = ((h << 5) + h) ^ cleanTerm.charCodeAt(i);
      }
      const rawPos = Math.abs(h) % MAX_UINT32;
      const angle = Math.round((rawPos / MAX_UINT32) * 360);

      // Guess backend node
      const nodes = ['A', 'B', 'C'];
      const guessedNode = nodes[Math.abs(h) % 3];

      setTraceData({
        prefix: term.toLowerCase(),
        cacheKey: cleanTerm,
        hashValue: Math.abs(h).toString(16).padStart(32, '0'),
        hashInt: rawPos,
        position: angle,
        node: guessedNode,
        nodeAddress: guessedNode === 'A' ? '127.0.0.1:6379' : guessedNode === 'B' ? '127.0.0.1:6380' : '127.0.0.1:6381',
        port: NODE_PORTS[guessedNode],
        latencyMs: 2,
      });
    } finally {
      setIsTracing(false);
    }
  }, []);

  // Compute active routing path and steps dynamically
  const routing = useMemo(() => {
    if (!traceData || vnodes.length === 0) return null;

    const keyRawPos = traceData.hashInt;
    const keyAngle = traceData.position;
    const activeVnodes = vnodes.filter(v => v.node !== failedNode);

    if (activeVnodes.length === 0) {
      return {
        targetVnode: null,
        finalNode: null,
        finalPort: null,
        steps: [
          { num: 1, title: 'Normalize prefix',    value: `"${currentQuery}" ➔ "${traceData.prefix}"`, color: '#3B82F6' },
          { num: 2, title: 'Build cache key',     value: traceData.cacheKey,                        color: '#3B82F6' },
          { num: 3, title: 'MD5 hash key',        value: traceData.hashValue,                       color: '#8B5CF6' },
          { num: 4, title: 'Ring position',       value: `${keyAngle}° on ring`,                    color: '#F59E0B' },
          { num: 5, title: 'Routing Error',       value: 'All cache nodes are offline!',            color: '#EF4444' },
        ]
      };
    }

    // Find next clockwise vnode
    let target = activeVnodes.find(v => v.rawPosition >= keyRawPos);
    if (!target) {
      target = activeVnodes[0];
    }

    const finalNode = target.node;
    const finalPort = NODE_PORTS[finalNode] || 6379;
    const isRedirected = failedNode === traceData.node;

    const steps = [
      { num: 1, title: 'Normalize prefix',    value: `"${currentQuery}" ➔ "${traceData.prefix}"`, color: '#3B82F6' },
      { num: 2, title: 'Build cache key',     value: traceData.cacheKey,                        color: '#3B82F6' },
      { num: 3, title: 'MD5 hash key',        value: traceData.hashValue,                       color: '#8B5CF6' },
      { num: 4, title: 'Ring position',       value: `${keyAngle}° (Unsigned 32-bit: ${keyRawPos.toLocaleString()})`, color: '#F59E0B' },
    ];

    if (isRedirected) {
      steps.push({
        num: 5,
        title: `Node ${traceData.node} Offline`,
        value: `Redistributing key clockwise on ring...`,
        color: '#EF4444'
      });
      steps.push({
        num: 6,
        title: 'Failover Destination',
        value: `Routed to Node ${finalNode} (:${finalPort}) at closest vnode ${target.position}°`,
        color: NODE_COLORS[finalNode]
      });
    } else {
      steps.push({
        num: 5,
        title: 'Owner Node Mapping',
        value: `Routed to Node ${finalNode} (:${finalPort}) at closest vnode ${target.position}°`,
        color: NODE_COLORS[finalNode]
      });
    }

    steps.push({
      num: isRedirected ? 7 : 6,
      title: 'Redis command execution',
      value: `ZREVRANGE ${traceData.cacheKey} 0 9 WITHSCORES`,
      color: '#10B981'
    });

    return {
      targetVnode: target,
      finalNode,
      finalPort,
      steps
    };
  }, [traceData, vnodes, failedNode, currentQuery]);

  // Stagger steps animation when trace data arrives
  useEffect(() => {
    if (routing) {
      setVisibleStepCount(0);
      let count = 0;
      const interval = setInterval(() => {
        count++;
        setVisibleStepCount(count);
        if (count >= routing.steps.length) {
          clearInterval(interval);
        }
      }, 200);
      return () => clearInterval(interval);
    }
  }, [traceData, routing?.steps?.length]);

  const activeVnodeCount = vnodes.filter(v => v.node !== failedNode).length;

  return (
    <div className="w-full">
      {/* Header with Sim controls */}
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-800/80 pb-4">
        <div>
          <h2 className="text-xl font-bold text-white mb-0.5">⚡ Consistent Hashing Visual Ring</h2>
          <p className="text-slate-400 text-xs">
            See how your search query hashes and routes to active Redis cluster nodes.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 bg-slate-900/60 border border-slate-800/60 px-3 py-1 rounded-xl">
            <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Simulate Offline:</span>
            {['A', 'B', 'C'].map(nodeId => (
              <button 
                key={nodeId} 
                id={`fail-node-${nodeId}`} 
                onClick={() => setFailedNode(failedNode === nodeId ? null : nodeId)}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${
                  failedNode === nodeId 
                    ? 'bg-red-500/20 border-red-500/50 text-red-400 font-bold' 
                    : 'bg-slate-800 border-slate-700/60 text-slate-400 hover:text-white'
                }`}
              >
                Node {nodeId}
              </button>
            ))}
          </div>
          <button 
            onClick={fetchRingNodes}
            disabled={loadingVnodes}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-800 bg-slate-900/40 text-xs text-slate-400 hover:text-white transition-all disabled:opacity-40"
            title="Refresh ring topology"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingVnodes ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Failure Banner */}
      {failedNode && (
        <div className="mb-5 flex items-start gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <strong>Node {failedNode} Simulated Down.</strong> All of its 160 virtual nodes are temporarily inactive on the ring. Key routing automatically shifts clockwise to the next active virtual node, ensuring <strong>minimal cache disruption</strong> (only Node {failedNode}'s keys are affected).
          </div>
        </div>
      )}

      {/* Visual Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mb-8">
        
        {/* SVG Ring Column */}
        <div className="lg:col-span-3 glass-card p-6 flex flex-col items-center justify-center relative min-h-[460px]">
          <div className="absolute top-4 left-4 text-xs font-bold text-slate-500 bg-slate-950/40 border border-slate-800 px-2.5 py-1 rounded-lg">
            Active Ring State: {activeVnodeCount} / {vnodes.length} Vnodes
          </div>
          
          <svg viewBox="0 0 500 500" className="w-full max-w-sm sm:max-w-md" aria-label="Consistent Hash Ring Visualizer">
            <defs>
              <filter id="glow"><feGaussianBlur stdDeviation="3" result="coloredBlur"/><feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
              <radialGradient id="bg" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#0f172a"/>
                <stop offset="100%" stopColor="#020617"/>
              </radialGradient>
            </defs>

            {/* Inner Ring Circle */}
            <circle cx={CX} cy={CY} r={R - 15} fill="url(#bg)" />

            {/* Circumference Ring Line */}
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="#1e293b" strokeWidth="3" />

            {/* 480 Virtual Nodes plotted along the ring */}
            {vnodes.map((v, i) => {
              const isFailed = failedNode === v.node;
              const coord = ringToSVG(v.position, R);
              return (
                <circle
                  key={i}
                  cx={coord.x}
                  cy={coord.y}
                  r={isFailed ? 1.5 : 2.5}
                  fill={isFailed ? '#334155' : NODE_COLORS[v.node]}
                  opacity={isFailed ? 0.15 : 0.8}
                />
              );
            })}

            {/* Sweep Arc Path when tracing route */}
            {traceData && routing?.targetVnode && (
              <path
                d={getSweepingArcPath(traceData.position, routing.targetVnode.position, R)}
                fill="none"
                stroke="#F97316"
                strokeWidth="4"
                strokeDasharray="6,3"
                opacity="0.8"
                filter="url(#glow)"
              />
            )}

            {/* Radial Line from center to key's hashed position */}
            {traceData && (
              <line 
                x1={CX} 
                y1={CY} 
                x2={ringToSVG(traceData.position, R).x} 
                y2={ringToSVG(traceData.position, R).y} 
                stroke="#F97316" 
                strokeWidth="1.5" 
                strokeDasharray="5,4" 
                opacity="0.6" 
              />
            )}

            {/* Pulse Marker at Key's Position */}
            {traceData && (
              <g>
                <circle 
                  cx={ringToSVG(traceData.position, R).x} 
                  cy={ringToSVG(traceData.position, R).y} 
                  r={12} 
                  fill="#F97316" 
                  opacity="0.25" 
                  filter="url(#glow)" 
                  className="animate-pulse"
                />
                <circle 
                  cx={ringToSVG(traceData.position, R).x} 
                  cy={ringToSVG(traceData.position, R).y} 
                  r={7} 
                  fill="#F97316" 
                  stroke="white" 
                  strokeWidth="2" 
                />
              </g>
            )}

            {/* Glowing circle around the target vnode mapping */}
            {traceData && routing?.targetVnode && (
              <g>
                <circle
                  cx={ringToSVG(routing.targetVnode.position, R).x}
                  cy={ringToSVG(routing.targetVnode.position, R).y}
                  r={12}
                  fill="none"
                  stroke={NODE_COLORS[routing.targetVnode.node]}
                  strokeWidth={2.5}
                  className="animate-ping"
                />
                <circle
                  cx={ringToSVG(routing.targetVnode.position, R).x}
                  cy={ringToSVG(routing.targetVnode.position, R).y}
                  r={5}
                  fill={NODE_COLORS[routing.targetVnode.node]}
                  stroke="white"
                  strokeWidth={1}
                />
              </g>
            )}

            {/* 3 Large Nominal Physical Node Landmarks */}
            {[
              { id: 'A', angle: 0,   color: NODE_COLORS.A },
              { id: 'B', angle: 120, color: NODE_COLORS.B },
              { id: 'C', angle: 240, color: NODE_COLORS.C },
            ].map(p => {
              const pos = ringToSVG(p.angle, R + 35);
              const isFailed = failedNode === p.id;
              return (
                <g key={p.id} className="transition-all duration-300">
                  <circle 
                    cx={pos.x} 
                    cy={pos.y} 
                    r={22} 
                    fill={isFailed ? '#1e293b' : p.color + '15'} 
                    stroke={isFailed ? '#ef444450' : p.color + '30'}
                    strokeWidth="1.5"
                  />
                  <circle 
                    cx={pos.x} 
                    cy={pos.y} 
                    r={15} 
                    fill={isFailed ? '#ef444415' : p.color} 
                    stroke={isFailed ? '#ef4444' : 'white'} 
                    strokeWidth="1.5" 
                  />
                  <text 
                    x={pos.x} 
                    y={pos.y + 4.5} 
                    textAnchor="middle" 
                    fill={isFailed ? '#ef4444' : 'white'} 
                    fontSize="11.5" 
                    fontWeight="700"
                  >
                    {p.id}
                  </text>
                  <text 
                    x={pos.x} 
                    y={p.angle === 0 ? pos.y - 28 : pos.y + 28} 
                    textAnchor="middle" 
                    fill={isFailed ? '#ef4444' : '#94a3b8'} 
                    fontSize="10" 
                    fontWeight="600"
                  >
                    {isFailed ? 'DOWN' : `port :${NODE_PORTS[p.id]}`}
                  </text>
                </g>
              );
            })}

            {/* Center Label */}
            <text x={CX} y={CY - 10} textAnchor="middle" fill="#94a3b8" fontSize="13" fontWeight="700">MD5 RING</text>
            <text x={CX} y={CY + 10} textAnchor="middle" fill="#64748b" fontSize="11">Ketama ➔ 32-bit</text>
            {traceData && (
              <text x={CX} y={CY + 28} textAnchor="middle" fill="#F97316" fontSize="11" fontWeight="600">
                Key Pos: {traceData.position}°
              </text>
            )}
          </svg>
          
          {/* Legend */}
          <div className="flex items-center gap-6 mt-4 border-t border-slate-800/80 pt-4 w-full justify-center">
            {['A', 'B', 'C'].map(nodeId => (
              <div key={nodeId} className="flex items-center gap-1.5">
                <div 
                  className="w-3.5 h-3.5 rounded-full" 
                  style={{ background: failedNode === nodeId ? '#334155' : NODE_COLORS[nodeId] }} 
                />
                <span className={`text-xs font-semibold ${failedNode === nodeId ? 'text-slate-500 line-through' : 'text-slate-300'}`}>
                  Node {nodeId} (:{NODE_PORTS[nodeId]})
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Trace and Allocation Panel Column */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          
          {/* Trace Output */}
          <div className="glass-card p-5 flex-1 flex flex-col">
            <div className="section-title mb-3 flex items-center justify-between">
              <span>Routing Trace</span>
              {traceData && (
                <span className="badge badge-purple text-[10px]">
                  1 Hash Call
                </span>
              )}
            </div>
            
            {(!traceData || routing?.steps == null) && !isTracing && (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 py-8 text-center bg-slate-950/20 rounded-xl border border-dashed border-slate-800/80">
                <Info className="w-7 h-7 text-slate-600 animate-pulse" />
                <p className="text-xs text-slate-400 font-medium">Real-Time Routing Trace</p>
                <p className="text-[10px] text-slate-500 max-w-[200px]">
                  Type a query in the search bar above to trace how the prefix is hashed and routed across the cluster.
                </p>
              </div>
            )}
            
            {isTracing && (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 py-8 text-slate-400">
                <RefreshCw className="w-6 h-6 animate-spin text-brand-500" />
                <span className="text-sm font-semibold">Hashing & Querying ring...</span>
              </div>
            )}
            
            {traceData && routing?.steps && (
              <div className="flex-1 flex flex-col justify-between">
                <div className="divide-y divide-slate-800/60 max-h-[300px] overflow-y-auto pr-1">
                  {routing.steps.slice(0, visibleStepCount).map((step, idx) => (
                    <div key={idx} className="flex items-start gap-3 py-2.5 first:pt-0">
                      <div 
                        className="w-5.5 h-5.5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5"
                        style={{ 
                          background: `${step.color}15`, 
                          color: step.color, 
                          border: `1px solid ${step.color}40` 
                        }}
                      >
                        {step.num}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-slate-300">{step.title}</div>
                        <div className="text-[11px] text-slate-500 font-mono mt-0.5 break-all leading-relaxed">
                          {step.value}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                
                {visibleStepCount >= routing.steps.length && routing.finalNode && (
                  <div className="mt-4 pt-4 border-t border-slate-800 flex items-center justify-between text-xs bg-slate-950/30 p-2.5 rounded-xl border border-slate-800">
                    <span className="text-slate-400 font-medium flex items-center gap-1">
                      <Shield className="w-3.5 h-3.5 text-brand-500" />
                      Final target:
                    </span>
                    <span 
                      className="font-bold text-xs px-2.5 py-1 rounded-lg shadow-sm"
                      style={{ 
                        background: NODE_BG_COLORS[routing.finalNode], 
                        color: NODE_COLORS[routing.finalNode] 
                      }}
                    >
                      Node {routing.finalNode} (port :{routing.finalPort})
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Allocation Details */}
          <div className="glass-card p-5">
            <div className="section-title mb-3">Node Status & Allocation</div>
            <div className="space-y-3">
              {['A', 'B', 'C'].map((nodeId) => {
                const isFailed = failedNode === nodeId;
                const color = NODE_COLORS[nodeId];
                const port = NODE_PORTS[nodeId];
                const vnodeCount = isFailed ? 0 : 160;
                return (
                  <div 
                    key={nodeId} 
                    className="flex items-center justify-between p-3 rounded-xl border transition-all duration-200"
                    style={{
                      background: isFailed ? 'rgba(239,68,68,0.03)' : `${color}05`,
                      borderColor: isFailed ? 'rgba(239,68,68,0.15)' : `${color}20`
                    }}
                  >
                    <div className="flex items-center gap-2.5">
                      <div 
                        className="w-3 h-3 rounded-full shadow-sm" 
                        style={{ background: isFailed ? '#ef4444' : color }} 
                      />
                      <div>
                        <div className="text-sm font-bold text-white">Node {nodeId}</div>
                        <div className="text-xs text-slate-400 font-mono">127.0.0.1:{port}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${
                        isFailed ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-teal-500/10 text-teal-400 border border-teal-500/20'
                      }`}>
                        {isFailed ? 'OFFLINE' : 'ONLINE'}
                      </span>
                      <div className="text-[10px] text-slate-500 mt-1 font-mono">{vnodeCount} vnodes</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Educational Explanation Box */}
      <div className="glass-card p-6">
        <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-3">
          <HelpCircle className="w-5 h-5 text-purple-400" />
          How Hashing Functions Work in Consistent Hashing
        </h3>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="flex flex-col gap-2 p-4 rounded-xl bg-slate-950/40 border border-slate-800/80">
            <div className="text-xs font-bold text-purple-400 uppercase tracking-wide">1. The Single Hash Rule</div>
            <div className="text-sm text-slate-200 font-semibold mt-1">1 Hash Function (MD5)</div>
            <p className="text-xs text-slate-400 leading-relaxed mt-1">
              Consistent Hashing requires only <strong>one hash function</strong>. The same function (MD5) maps both server nodes (nodes placed via virtual names) and query keys (search strings) onto the exact same circular keyspace of <code>[0, 2³² - 1]</code>.
            </p>
          </div>
          
          <div className="flex flex-col gap-2 p-4 rounded-xl bg-slate-950/40 border border-slate-800/80">
            <div className="text-xs font-bold text-brand-400 uppercase tracking-wide">2. Ring Setup (Pre-calculated)</div>
            <div className="text-sm text-slate-200 font-semibold mt-1">120 MD5 Invocations</div>
            <p className="text-xs text-slate-400 leading-relaxed mt-1">
              For 160 vnodes per physical node, Ketama groups them in sets of 4 using the MD5 digest of the node name (e.g. <code>NodeA-0</code>). Thus, MD5 is called 40 times per node, resulting in <strong>120 setup-phase calls</strong> to pre-calculate 480 positions on the ring.
            </p>
          </div>
          
          <div className="flex flex-col gap-2 p-4 rounded-xl bg-slate-950/40 border border-slate-800/80">
            <div className="text-xs font-bold text-teal-400 uppercase tracking-wide">3. Lookup Phase (Real-time)</div>
            <div className="text-sm text-slate-200 font-semibold mt-1">Exactly 1 Hash Call</div>
            <p className="text-xs text-slate-400 leading-relaxed mt-1">
              When checking suggestions, the search prefix (e.g. <code>suggest:iphone</code>) is hashed <strong>exactly 1 time</strong> with MD5 to find its position. Then, we find the first virtual node index greater than the key's position in <code>O(log N)</code> time.
            </p>
          </div>
        </div>
        
        <div className="mt-4 p-4 rounded-xl bg-purple-500/5 border border-purple-500/10 flex items-center gap-3">
          <CheckCircle className="w-5 h-5 text-purple-400 shrink-0" />
          <p className="text-xs text-slate-300">
            <strong>Key Benefit of virtual nodes:</strong> Virtual nodes prevent "hot spots" by shuffling node placement uniformly, meaning keys are distributed evenly even if servers have non-uniform weights.
          </p>
        </div>
      </div>
    </div>
  );
}
