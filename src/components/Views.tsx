import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowDown, ArrowRight, Check, ChevronRight, Cpu, Database, Layers, Network, Terminal, X } from 'lucide-react';
import { SimulationEngine } from '../simulation/engine';
import { active } from '../simulation/types';
import type { Request, Sample } from '../simulation/types';
import { Tip } from './Controls';

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
export function Sparkline({ samples, field, color, large = false }: { samples: Sample[]; field: 'tokens' | 'gpu' | 'kv'; color: string; large?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const box = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = box.width * dpr; canvas.height = box.height * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      const w = box.width, h = box.height;
      ctx.clearRect(0, 0, w, h);
      if (large) {
        ctx.strokeStyle = '#292d31'; ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, i * h / 4); ctx.lineTo(w, i * h / 4); ctx.stroke(); }
      }
      const data = samples.slice(-100);
      if (!data.length) return;
      const max = field === 'tokens' ? Math.max(10, ...data.map(s => s[field])) : 100;
      const latest = data.at(-1)!.at;
      const points = data.map(s => [w * (1 - (latest - s.at) / 10000), h - 3 - s[field] / max * (h - 6)]);
      ctx.strokeStyle = color; ctx.lineWidth = large ? 2 : 1.5; ctx.beginPath();
      points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
      if (large) {
        ctx.lineTo(points.at(-1)![0], h); ctx.lineTo(points[0][0], h); ctx.closePath(); ctx.fillStyle = color + '12'; ctx.fill();
      }
    };
    draw();
    const observer = new ResizeObserver(draw); observer.observe(canvas);
    return () => observer.disconnect();
  }, [samples.length, samples.at(-1)?.at, field, color, large]);
  return <canvas ref={ref} className={large ? 'chart-canvas' : 'sparkline'} aria-label={`${field} history`} role="img" />;
}
export function MetricsStrip({ engine }: { engine: SimulationEngine }) {
  const m = engine.metrics;
  const items = [
    { label: 'TTFT', value: m.ttft === null ? '--' : fmt(m.ttft), unit: 'ms', tip: 'Lifetime mean arrival-to-first-token latency, including queue time. Requests contribute when their first token is emitted.' },
    { label: 'TPOT', value: m.tpot === null ? '--' : m.tpot.toFixed(1), unit: 'ms / tok', tip: 'Token-weighted time between emitted output tokens, excluding the first token. Speculative tokens emitted together have zero internal spacing.' },
    { label: 'OUTPUT THROUGHPUT', value: fmt(m.tokensPerSecond), unit: 'tok / s', tip: 'Generated output tokens over the trailing one second of simulation time; prompt tokens are excluded.', field: 'tokens' as const, color: '#66d7b0' },
    { label: 'GPU UTILIZATION', value: fmt(m.gpuUtilization), unit: '%', tip: 'Synthetic occupancy estimate from phase and batch fill, averaged over GPU workers. Not hardware telemetry.', field: 'gpu' as const, color: '#73b5f5' },
    { label: 'KV CACHE', value: fmt(m.kvUtilization), unit: '%', tip: 'Physical pages occupied by active or retained prefix data divided by total pages across replicas.', field: 'kv' as const, color: '#d39be3' },
    { label: 'PREFIX HIT RATE', value: fmt(m.prefixHitRate), unit: '%', tip: 'Admitted prefix-eligible requests reusing at least one full page divided by prefix-eligible lookups while caching is enabled.' },
  ];
  return <div className="metrics-strip">{items.map(item => <div className="metric" key={item.label}>
    <div className="metric-label">{item.label}<Tip text={item.tip} /></div>
    <div className="metric-value"><strong>{item.value}</strong><span>{item.unit}</span></div>
    {item.field && <Sparkline samples={engine.samples} field={item.field} color={item.color!} />}
  </div>)}</div>;
}
export function Workers({ engine, select }: { engine: SimulationEngine; select: (id: string) => void }) {
  return <section className="workers-section">
    <div className="section-heading"><h2><Cpu size={15} /> GPU workers</h2><span className="subtle">{engine.pools.length} replica{engine.pools.length > 1 ? 's' : ''} / TP {engine.config.tensorParallel}</span></div>
    <div className="replicas">{engine.pools.map((pool, group) => <div className="replica" key={group}>
      <div className="replica-title"><span>REPLICA {group.toString().padStart(2, '0')}</span><span><Network size={11} /> {engine.config.tensorParallel > 1 ? 'All-reduce ring' : 'Independent worker'}</span></div>
      <div className={`worker-grid ${engine.config.tensorParallel > 1 ? 'parallel-workers' : ''}`}>{engine.workers.filter(w => w.group === group).map(w => <div className={`worker ${w.phase}`} key={w.id} data-worker={w.id}>
        <div className="worker-title"><Cpu size={16} /><strong>GPU {w.id}</strong><span className="rank">rank {w.rank}</span><span className={`dot ${w.phase}`} /></div>
        <div className="worker-util"><strong>{Math.round(w.utilization)}<small>%</small></strong><span className={`phase-label ${w.phase}`}>{w.phase}</span></div>
        <div className="util-bar"><span style={{ width: `${w.utilization}%` }} /></div>
        <div className="worker-requests">{w.requestIds.length ? w.requestIds.map(id => {
          const r = engine.requests.find(r => r.id === id)!;
          return <button className={`request-chip ${r.status}`} key={id} onClick={() => select(id)} title={`${id}: ${r.status}, ${r.generated}/${r.outputTokens} output tokens`}>{id}<span /></button>;
        }) : <span className="idle-label">No scheduled sequences</span>}</div>
      </div>)}</div>
      {engine.config.tensorParallel > 1 && <div className="tp-ring" aria-label={`Replica ${group} all-reduce ring`}>
        <Network size={12} />{engine.workers.filter(w => w.group === group).map(w => <span className="tp-link" key={w.id}><span className={`tp-node ${w.phase === 'idle' ? '' : 'busy'}`} title={`GPU ${w.id}, rank ${w.rank}, KV shard ${w.rank + 1}/${engine.config.tensorParallel}`}>{w.rank}</span><ArrowRight size={11} /></span>)}<span className="mono" title="Ring closes back to rank 0">0</span>
      </div>}
      <div className="replica-foot"><span>{pool.pinned} pinned pages</span><span>{pool.blocks.filter(b => b.key && !b.owners.length).length} cached</span><span>{pool.capacity - pool.occupied} free</span></div>
    </div>)}</div>
  </section>;
}

export function Queue({ engine, selected, select, cancel }: { engine: SimulationEngine; selected: string | null; select: (id: string) => void; cancel: (id: string) => void }) {
  const [filter, setFilter] = useState('live');
  const requests = engine.requests.filter(r => filter === 'all' || r.status === 'waiting' || active(r));
  return <section className="queue-section">
    <div className="section-heading"><h2><Layers size={15} /> Request queue <span className="count">{engine.metrics.waiting}</span></h2>
      <div className="segmented"><button className={filter === 'live' ? 'selected' : ''} onClick={() => setFilter('live')}>Live</button><button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>History</button></div>
    </div>
    <div className="table-scroll"><table className="request-table"><thead><tr><th>REQUEST</th><th>PHASE</th><th>PROMPT</th><th>OUTPUT</th><th>KV</th><th /></tr></thead>
      <tbody>{requests.slice(-60).map(r => <tr key={r.id} className={selected === r.id ? 'selected-row' : ''}>
        <td><button className="request-link" onClick={() => select(r.id)}><span className={`dot ${r.status}`} />{r.id}</button></td>
        <td><span className={`phase-label ${r.status}`} title={`${r.priority} · ${r.reason}`}>{r.recomputing && r.status === 'waiting' ? 'preempted' : r.recomputing && r.status === 'prefill' ? 'recompute' : r.status}</span></td>
        <td>{r.processed}<span className="muted">/{r.promptTokens}</span></td>
        <td>{r.generated}<span className="muted">/{r.outputTokens}</span></td>
        <td>{r.blockTable.length}</td><td>{(active(r) || r.status === 'waiting') && <button className="icon-button tiny" aria-label={`Cancel ${r.id}`} onClick={() => cancel(r.id)}><X size={12} /></button>}</td>
      </tr>)}</tbody></table>
      {!requests.length && <div className="empty-state"><Check size={20} /><span>Queue drained</span></div>}
    </div>
    <div className="queue-footer"><span><i className="dot decode" /> {engine.metrics.active} active</span><span><i className="dot waiting" /> {engine.metrics.waiting} waiting</span><span>{engine.metrics.completed} completed</span></div>
  </section>;
}

export function Cache({ engine, selected, select }: { engine: SimulationEngine; selected: string | null; select: (id: string) => void }) {
  const [group, setGroup] = useState(0);
  const [blockId, setBlockId] = useState<number | null>(null);
  const current = Math.min(group, engine.pools.length - 1);
  const pool = engine.pools[current];
  const block = blockId === null ? null : pool.blocks[blockId];
  const r = engine.requests.find(r => r.id === selected);
  useEffect(() => {
    if (r?.group !== null && r?.group !== undefined) setGroup(r.group);
  }, [selected, r?.group]);
  return <section className="cache-section">
    <div className="section-heading"><h2><Database size={15} /> KV cache <Tip text="A replica has one logical page pool, sharded across its TP ranks. Retained full prefix pages can be shared; mutable tail pages belong to one sequence." /></h2>
      <select className="compact-select" aria-label="Cache replica" value={current} onChange={e => { setGroup(Number(e.target.value)); setBlockId(null); }}>
        {engine.pools.map((_, i) => <option key={i} value={i}>Replica {i.toString().padStart(2, '0')}</option>)}
      </select>
    </div>
    <div className="cache-summary"><strong>{pool.occupied}<span> / {pool.capacity} blocks</span></strong><span>{engine.config.blockSize} tokens / block</span></div>
    <div className="cache-grid" aria-label="Physical KV block map">{pool.blocks.map(b => {
      const owner = engine.requests.find(r => r.id === b.owners[0]);
      const state = b.owners.length > 1 ? 'shared' : owner ? owner.status : b.key ? 'cached' : 'free';
      const match = selected && b.owners.includes(selected);
      return <button key={b.id} aria-label={`Block ${b.id}: ${state}`} title={`Physical block ${b.id} | ${state} | ${b.used}/${pool.blockSize} tokens | ${b.owners.join(', ') || b.key || 'free'} | reused ${b.generation}x`}
        className={`kv-block ${state} ${match ? 'highlighted' : ''} ${blockId === b.id ? 'focused' : ''}`} onClick={() => { setBlockId(b.id); if (b.owners[0]) select(b.owners[0]); }}>
        <span>{b.id.toString(16).padStart(2, '0')}</span>
      </button>;
    })}</div>
    <div className="legend">{['free', 'prefill', 'decode', 'cached', 'shared'].map(s => <span key={s}><i className={`swatch ${s}`} />{s}</span>)}</div>
    {block && <div className="block-detail"><span>PAGE {block.id.toString(16).padStart(2, '0').toUpperCase()}</span><b>{block.used}/{pool.blockSize} tokens</b><span>refs {block.owners.length}</span><span>generation {block.generation}</span></div>}
    <div className="page-table">
      <div className="section-heading small"><h3>Logical <ArrowRight size={12} /> physical</h3><span className="mono">{r ? `${r.id} / G${r.group ?? '-'}` : 'No sequence'}</span></div>
      <div className="page-entries">{r?.blockTable.length ? r.blockTable.slice(0, 32).map((id, i) => <span key={i} className="page-entry">L{i}<ChevronRight size={10} /><b>P{id}</b></span>) : <span className="muted">No pages allocated</span>}{r && r.blockTable.length > 32 && <span className="muted">+{r.blockTable.length - 32} pages</span>}</div>
      {r && <div className="mapping-foot"><span>{r.cachedTokens} prefix tokens reused</span><span>{active(r) ? 'Live mapping' : 'Last allocation'}</span></div>}
    </div>
    <div className="cache-footer"><span><ArrowDown size={12} /> {engine.metrics.evictions} LRU evictions</span><span>{fmt(engine.metrics.cachedTokens)} tokens reused</span></div>
  </section>;
}

export function Timeline({ engine, select }: { engine: SimulationEngine; select: (id: string) => void }) {
  const rows = engine.requests.filter(r => r.spans.length).slice(-10);
  const end = Math.max(engine.now, 1000);
  const start = Math.max(0, end - 12000);
  const position = (n: number) => Math.max(0, Math.min(100, (n - start) / (end - start) * 100));
  return <section className="timeline-section" data-testid="timeline">
    <div className="section-heading"><h2><Activity size={15} /> Execution timeline</h2><div className="legend"><span><i className="swatch waiting" />Queued</span><span><i className="swatch prefill" />Prefill</span><span><i className="swatch decode" />Decode</span></div></div>
    <div className="timeline-axis"><span>SEQUENCE</span><div>{[0, 1, 2, 3, 4].map(i => <span key={i}>{((start + (end - start) * i / 4) / 1000).toFixed(1)}s</span>)}</div></div>
    <div className="timeline-rows">{rows.map(r => <div className="timeline-row" key={r.id}>
      <button className="request-link" onClick={() => select(r.id)}>{r.id}<span className="muted">G{r.group}</span></button>
      <div className="timeline-track">
        {r.admittedAt !== undefined && r.admittedAt > start && <span className="timeline-span waiting" style={{ left: `${position(r.arrivedAt)}%`, width: `${position(r.admittedAt) - position(r.arrivedAt)}%` }} title={`${r.id} queue: ${r.admittedAt - r.arrivedAt}ms`} />}
        {r.spans.filter(s => s.end >= start).map((s, i) => <span key={i} className={`timeline-span ${s.phase}`} style={{ left: `${position(s.start)}%`, width: `${Math.max(0.1, position(s.end) - position(s.start))}%` }} title={`${r.id} ${s.phase}: ${s.tokens ?? 0} tokens / iteration ${s.iteration ?? '—'} / ${s.end - s.start}ms`} />)}
        {r.firstTokenAt !== undefined && r.firstTokenAt >= start && <i className="first-token" style={{ left: `${position(r.firstTokenAt)}%` }} title={`First token at ${r.firstTokenAt}ms`} />}
      </div>
    </div>)}</div>
    {!rows.length && <div className="empty-state">No execution samples</div>}
  </section>;
}

export function Inspector({ request, expert = true }: { request?: Request; expert?: boolean }) {
  return <section className="inspector">
    <div className="section-heading"><h2><Terminal size={15} /> Sequence inspector</h2><span className="mono">{request?.id ?? '--'}</span></div>
    {request ? <>
      <div className="inspector-grid">
        <div><span>STATE</span><b className={request.status}>{request.status}</b></div>
        <div><span>PREFIX FAMILY</span><b>{request.prefix}</b></div>
        <div><span>TTFT</span><b>{request.firstTokenAt === undefined ? '--' : `${request.firstTokenAt - request.arrivedAt} ms`}</b></div>
        <div><span>CACHED TOKENS</span><b>{request.cachedTokens}</b></div>
        {expert && <><div><span>PRIORITY / PREEMPTIONS</span><b>{request.priority} / {request.preemptions}</b></div>
        <div><span>RECOMPUTED TOKENS</span><b>{request.recomputedTokens}</b></div></>}
      </div>
      <div className="token-progress"><div><span>{request.recomputing ? 'Recompute context' : 'Prefill'}</span><b>{request.processed} / {request.recomputing ? request.recomputeUntil : request.promptTokens}</b></div><div className="progress-track"><span className="prefill" style={{ width: `${Math.min(100, request.processed / (request.recomputing ? request.recomputeUntil : request.promptTokens) * 100)}%` }} /></div></div>
      <div className="token-progress"><div><span>Decode</span><b>{request.generated} / {request.outputTokens}</b></div><div className="progress-track"><span className="decode" style={{ width: `${request.generated / request.outputTokens * 100}%` }} /></div></div>
      {request.speculative && <div className="spec-tokens"><span>DRAFT VERIFY</span>{Array.from({ length: request.speculative.drafted }, (_, i) => <span key={i} className={i < request.speculative!.accepted ? 'accepted' : 'rejected'} title={i < request.speculative!.accepted ? 'Accepted draft token' : 'Discarded draft suffix'}>{i < request.speculative!.accepted ? <Check size={13} /> : <X size={13} />}</span>)}<ArrowRight size={12} /><b>commit</b></div>}
      <div className="decision-reason"><span className={`dot ${request.status}`} />{request.reason}</div>
    </> : <div className="empty-state">No selected sequence</div>}
  </section>;
}
export function Telemetry({ engine }: { engine: SimulationEngine }) {
  const m = engine.metrics;
  return <section className="telemetry">
    <div className="section-heading"><h2><Activity size={15} /> Output throughput</h2><span className="green mono">{fmt(m.tokensPerSecond)} tok/s</span></div>
    <Sparkline samples={engine.samples} field="tokens" color="#66d7b0" large />
    <div className="chart-labels"><span>-10s</span><span>SIMULATION TIME</span><span>now</span></div>
    <div className="telemetry-stats"><div><span>REQUESTS / SEC</span><b>{m.requestsPerSecond.toFixed(1)}</b></div><div><span>OUTPUT TOKENS</span><b>{fmt(m.outputTokens)}</b></div><div><span>DRAFT ACCEPTANCE</span><b>{m.drafted ? `${Math.round(m.accepted / m.drafted * 100)}%` : '--'}</b></div></div>
  </section>;
}
export function SchedulerLog({ engine }: { engine: SimulationEngine }) {
  const [filter, setFilter] = useState('all');
  const events = engine.events.filter(e => filter === 'all' || e.type === filter);
  return <section className="scheduler-log">
    <div className="section-heading"><h2><Terminal size={15} /> Scheduler events <span className="count">{engine.events.length}</span></h2>
      <select aria-label="Event filter" className="compact-select" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All events</option>{['admit', 'wait', 'prefix', 'evict', 'verify', 'complete', 'reject'].map(e => <option key={e} value={e}>{e}</option>)}</select>
    </div>
    <div className="log-entries">{events.slice(0, 40).map(e => <div className="log-line" key={e.id}><time>{(e.at / 1000).toFixed(2)}</time><span className={`event-type ${e.type}`}>{e.type.toUpperCase()}</span><b>{e.requestId ?? 'SYS'}</b><span>{e.message}</span></div>)}
      {!events.length && <div className="empty-state">No matching events</div>}
    </div>
  </section>;
}
