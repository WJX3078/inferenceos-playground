import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowDown, ArrowRight, Check, ChevronRight, Cpu, Database, GitCompare, Layers, Network, Terminal, X } from 'lucide-react';
import { SimulationEngine } from '../simulation/engine';
import { active } from '../simulation/types';
import type { Config, Metrics, Phase, Request, Sample } from '../simulation/types';
import { Tip } from './Controls';

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const ms = (v: number | null) => v === null ? '--' : fmt(v);

export interface CapturedRun { label: string; config: Config; metrics: Metrics; at: number }

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
    {
      label: 'TTFT', value: ms(m.ttft), unit: 'ms mean', field: null,
      sub: `p50 ${ms(m.ttftP50)} · p95 ${ms(m.ttftP95)} · p99 ${ms(m.ttftP99)}`,
      tip: 'Time from arrival to the first emitted token, including queueing. Subline shows nearest-rank percentiles over all observed first tokens.',
    },
    {
      label: 'TPOT', value: m.tpot === null ? '--' : m.tpot.toFixed(1), unit: 'ms / tok mean', field: null,
      sub: `p50 ${m.tpotP50 === null ? '--' : m.tpotP50.toFixed(1)} · p95 ${m.tpotP95 === null ? '--' : m.tpotP95.toFixed(1)} · p99 ${m.tpotP99 === null ? '--' : m.tpotP99.toFixed(1)}`,
      tip: 'Time between emitted output tokens, excluding the first. Long prefills without decode priority inflate the tail — watch p99 under interference.',
    },
    {
      label: 'THROUGHPUT', value: fmt(m.tokensPerSecond), unit: 'tok / s', field: 'tokens' as const, color: '#66d7b0',
      sub: `${m.requestsPerSecond.toFixed(1)} req/s`, tip: 'Output tokens emitted over the trailing one second of simulation time.',
    },
    {
      label: 'GOODPUT', value: m.goodput.toFixed(2), unit: 'SLO req / s', field: null,
      sub: `SLO attainment ${m.sloAttainment.toFixed(0)}%`,
      tip: 'Completions meeting BOTH the TTFT and TPOT SLO per second. Throughput can rise while goodput collapses — that gap is the whole point.',
    },
    {
      label: 'GPU UTILIZATION', value: fmt(m.gpuUtilization), unit: '%', field: 'gpu' as const, color: '#73b5f5',
      sub: engine.config.servingMode === 'disaggregated'
        ? `P ${m.prefillUtilization.toFixed(0)}% · D ${m.decodeUtilization.toFixed(0)}%`
        : `budget ${m.tokenBudgetUtilization.toFixed(0)}%`,
      tip: 'Synthetic occupancy from phase and batch fill, averaged over workers. Not hardware telemetry.',
    },
    {
      label: 'KV CACHE', value: fmt(m.kvUtilization), unit: '%', field: 'kv' as const, color: '#d39be3',
      sub: `${m.evictions} evictions · ${m.preemptions} preempts`,
      tip: 'Physical blocks occupied by active sequences or retained prefix data, divided by total blocks across pools.',
    },
  ];
  return <>
    <div className="metrics-strip">{items.map(item => <div className="metric" key={item.label}>
      <div className="metric-label">{item.label}<Tip text={item.tip} /></div>
      <div className="metric-value"><strong>{item.value}</strong><span>{item.unit}</span></div>
      {item.field && <Sparkline samples={engine.samples} field={item.field} color={item.color!} />}
      <div className="metric-sub">{item.sub}</div>
    </div>)}</div>
    <div className="submetrics">
      <span>iteration <b>{m.schedulerIterations}</b></span>
      <span>prefix hits <b>{m.prefixHitRate.toFixed(0)}%</b></span>
      <span>recomputed <b>{fmt(m.recomputedTokens)}</b> tok</span>
      <span>spec accept <b>{m.drafted ? `${Math.round(m.accepted / m.drafted * 100)}%` : '--'}</b></span>
      {engine.config.servingMode === 'disaggregated' && <span>transfers <b>{m.transfersCompleted}</b> done / <b>{m.transfersActive}</b> active / <b>{m.transfersQueued}</b> queued · {(m.networkBytes / 1048576).toFixed(0)} MiB</span>}
      {engine.config.kvTiers !== 'gpu' && <span>tiers <b>{m.tierHitsGpu}</b>/<b>{m.tierHitsCpu}</b>/<b>{m.tierHitsRemote}</b> · restores <b>{m.restores}</b> · recompute <b>{m.tierRecomputes}</b></span>}
      <span>preempted <b>{m.preempted}</b></span>
    </div>
  </>;
}

export function BudgetBar({ engine }: { engine: SimulationEngine }) {
  const total = engine.config.maxNumBatchedTokens;
  const iters = engine.iterations;
  return <section className="budget-section" data-testid="budget-bar">
    <div className="section-heading"><h2><Layers size={15} /> Token budget per iteration</h2>
      <span className="subtle mono">{total} tok / pool · iteration {iters}</span></div>
    <div className="budget-rows">
      {engine.lastBudget.map((u, i) => {
        const d = u.decode / total * 100, pf = u.prefill / total * 100;
        return <div className="budget-row" key={i}>
          <span className="mono">G{i.toString().padStart(2, '0')}</span>
          <div className="budget-track" title={`Decode ${u.decode} · Prefill ${u.prefill} · Unused ${u.unused} tokens of ${u.total}`}>
            <span className="budget-seg decode" style={{ width: `${d}%` }} />
            <span className="budget-seg prefill" style={{ width: `${pf}%` }} />
          </div>
          <span className="subtle mono">{u.decode}D/{u.prefill}P/{u.unused}U</span>
        </div>;
      })}
    </div>
    <div className="legend"><span><i className="swatch decode" />decode</span><span><i className="swatch prefill" />prefill</span><span><i className="swatch free" />unused</span></div>
  </section>;
}

export function Workers({ engine, select }: { engine: SimulationEngine; select: (id: string) => void }) {
  const kindLabel = (kind: string) => kind === 'prefill' ? 'PREFILL POOL' : kind === 'decode' ? 'DECODE POOL' : 'REPLICA';
  return <section className="workers-section">
    <div className="section-heading"><h2><Cpu size={15} /> GPU workers</h2><span className="subtle">
      {engine.config.servingMode === 'disaggregated'
        ? `${engine.config.prefillGpuCount}P (${engine.config.prefillTP}×TP) + ${engine.config.decodeGpuCount}D (${engine.config.decodeTP}×TP)`
        : `${engine.pools.length} replica${engine.pools.length > 1 ? 's' : ''} / TP ${engine.config.tensorParallel}`}</span></div>
    <div className="replicas">{engine.pools.map((pool, group) => <div className="replica" key={group}>
      <div className="replica-title"><span>{kindLabel(engine.poolKinds[group])} {group.toString().padStart(2, '0')}</span><span><Network size={11} /> {engine.poolTP(group) > 1 ? 'All-reduce ring' : 'Independent worker'}</span></div>
      <div className={`worker-grid ${engine.poolTP(group) > 1 ? 'parallel-workers' : ''}`}>{engine.workers.filter(w => w.group === group).map(w => <div className={`worker ${w.phase}`} key={w.id} data-worker={w.id}>
        <div className="worker-title"><Cpu size={16} /><strong>GPU {w.id}</strong><span className="rank">rank {w.rank}</span><span className={`dot ${w.phase}`} /></div>
        <div className="worker-util"><strong>{Math.round(w.utilization)}<small>%</small></strong><span className={`phase-label ${w.phase}`}>{w.phase}</span></div>
        <div className="util-bar"><span style={{ width: `${w.utilization}%` }} /></div>
        <div className="worker-requests">{w.requestIds.length ? w.requestIds.map(id => {
          const r = engine.requests.find(r => r.id === id)!;
          return <button className={`request-chip ${r.status}`} key={id} onClick={() => select(id)} title={`${id}: ${r.status}, ${r.generated}/${r.outputTokens} output tokens`}>{id}<span /></button>;
        }) : <span className="idle-label">No scheduled sequences</span>}</div>
      </div>)}</div>
      {engine.poolTP(group) > 1 && <div className="tp-ring" aria-label={`Replica ${group} all-reduce ring`}>
        <Network size={12} />{engine.workers.filter(w => w.group === group).map(w => <span className="tp-link" key={w.id}><span className={`tp-node ${w.phase === 'idle' ? '' : 'busy'}`} title={`GPU ${w.id}, rank ${w.rank}, KV shard ${w.rank + 1}/${engine.poolTP(group)}`}>{w.rank}</span><ArrowRight size={11} /></span>)}<span className="mono" title="Ring closes back to rank 0">0</span>
      </div>}
      <div className="replica-foot"><span>{pool.pinned} pinned pages</span><span>{pool.cachedCount} cached</span><span>{pool.capacity - pool.occupied} free</span></div>
    </div>)}</div>
  </section>;
}

export function Queue({ engine, selected, select, cancel }: { engine: SimulationEngine; selected: string | null; select: (id: string) => void; cancel: (id: string) => void }) {
  const [filter, setFilter] = useState('live');
  const live = (r: Request) => r.status === 'waiting' || active(r) || r.status === 'preempted' ||
    r.status === 'transfer_wait' || r.status === 'transferring' || r.status === 'decode_wait';
  const requests = engine.requests.filter(r => filter === 'all' || live(r));
  return <section className="queue-section">
    <div className="section-heading"><h2><Layers size={15} /> Request queue <span className="count">{engine.metrics.waiting}</span></h2>
      <div className="segmented"><button className={filter === 'live' ? 'selected' : ''} onClick={() => setFilter('live')}>Live</button><button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>History</button></div>
    </div>
    <div className="table-scroll"><table className="request-table"><thead><tr><th>REQUEST</th><th>PHASE</th><th>PROMPT</th><th>OUTPUT</th><th>KV</th><th /></tr></thead>
      <tbody>{requests.slice(-60).map(r => <tr key={r.id} className={selected === r.id ? 'selected-row' : ''}>
        <td><button className="request-link" onClick={() => select(r.id)}><span className={`dot ${r.status}`} />{r.id}</button></td>
        <td><span className={`phase-label ${r.status}`} title={r.reason}>{r.status}</span></td>
        <td>{r.processed}<span className="muted">/{r.promptTokens}</span></td>
        <td>{r.generated}<span className="muted">/{r.outputTokens}</span></td>
        <td>{r.blockTable.length}</td><td>{(live(r)) && <button className="icon-button tiny" aria-label={`Cancel ${r.id}`} onClick={() => cancel(r.id)}><X size={12} /></button>}</td>
      </tr>)}</tbody></table>
      {!requests.length && <div className="empty-state"><Check size={20} /><span>Queue drained</span></div>}
    </div>
    <div className="queue-footer"><span><i className="dot decode" /> {engine.metrics.active} active</span><span><i className="dot waiting" /> {engine.metrics.waiting} waiting</span><span><i className="dot preempted" /> {engine.metrics.preempted} preempted</span><span>{engine.metrics.completed} completed</span></div>
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
    if (engine.config.servingMode !== 'disaggregated' && r?.group !== null && r?.group !== undefined) setGroup(r.group);
  }, [selected, r?.group, engine.config.servingMode]);
  return <section className="cache-section">
    <div className="section-heading"><h2><Database size={15} /> KV cache <Tip text="One logical block pool per replica, sharded across TP ranks. Immutable prefix blocks are content-addressed and shareable; mutable tails belong to one sequence. In disaggregated mode decode pools receive blocks via KV transfer." /></h2>
      <select className="compact-select" aria-label="Cache replica" value={current} onChange={e => { setGroup(Number(e.target.value)); setBlockId(null); }}>
        {engine.pools.map((_, i) => <option key={i} value={i}>Pool {i.toString().padStart(2, '0')} ({engine.poolKinds[i]})</option>)}
      </select>
    </div>
    <div className="cache-summary"><strong>{pool.occupied}<span> / {pool.capacity} blocks</span></strong><span>{engine.config.blockSize} tok / block · {(engine.config.blockSize * 2 * engine.config.numLayers * engine.config.numKVHeads * engine.config.headDim * engine.config.bytesPerElement / 1024).toFixed(0)} KiB / tok <Tip text="KV payload bytes per token = 2 (K+V) × layers × KV heads × head dim × bytes per element. Payload only: no weights, activations, allocator overhead or fragmentation." /></span></div>
    <div className="cache-grid" aria-label="Physical KV block map">{pool.blocks.map(b => {
      const owner = engine.requests.find(r => r.id === b.owners[0]);
      const state = b.owners.length > 1 ? 'shared' : owner ? owner.status : b.key ? 'cached' : 'free';
      const match = selected && b.owners.includes(selected);
      return <button key={b.id} aria-label={`Block ${b.id}: ${state}`} title={`Block ${b.id} | ${state} | ${b.used}/${pool.blockSize} tokens | ${b.owners.join(', ') || b.key?.slice(0, 8) || 'free'} | reused ${b.generation}x`}
        className={`kv-block ${state} ${match ? 'highlighted' : ''} ${blockId === b.id ? 'focused' : ''}`} onClick={() => { setBlockId(b.id); if (b.owners[0]) select(b.owners[0]); }}>
        <span>{b.id.toString(16).padStart(2, '0')}</span>
      </button>;
    })}</div>
    <div className="legend">{['free', 'prefill', 'decode', 'cached', 'shared'].map(s => <span key={s}><i className={`swatch ${s}`} />{s}</span>)}</div>
    {block && <div className="block-detail"><span>PAGE {block.id.toString(16).padStart(2, '0').toUpperCase()}</span><b>{block.used}/{pool.blockSize} tokens</b><span>refs {block.owners.length}</span><span>hash {block.key ? block.key.slice(0, 8) : '--'}</span><span>gen {block.generation}</span></div>}
    <div className="page-table">
      <div className="section-heading small"><h3>Logical <ArrowRight size={12} /> physical</h3><span className="mono">{r ? `${r.id} / pool ${r.group ?? '-'}` : 'No sequence'}</span></div>
      <div className="page-entries">{r?.blockTable.length ? r.blockTable.slice(0, 32).map((id, i) => <span key={i} className="page-entry">L{i}<ChevronRight size={10} /><b>P{id}</b></span>) : <span className="muted">No pages allocated</span>}{r && r.blockTable.length > 32 && <span className="muted">+{r.blockTable.length - 32} pages</span>}</div>
      {r && <div className="mapping-foot"><span>{r.cachedTokens} prefix tokens reused</span><span>{active(r) ? 'Live mapping' : 'Last allocation'}</span></div>}
    </div>
    <div className="cache-footer"><span><ArrowDown size={12} /> {engine.metrics.evictions} LRU evictions</span><span>{fmt(engine.metrics.cachedTokens)} tokens reused</span>{engine.config.kvTiers !== 'gpu' && <span>{fmt(engine.metrics.tierBytesMoved / 1048576)} MiB tiered</span>}</div>
  </section>;
}

const TIMELINE_PHASES: Phase[] = ['waiting', 'prefill', 'decode', 'preempted', 'transfer_wait', 'transferring', 'decode_wait'];

export function Timeline({ engine, select }: { engine: SimulationEngine; select: (id: string) => void }) {
  const rows = engine.requests.filter(r => r.spans.length).slice(-10);
  const end = Math.max(engine.now, 1000);
  const start = Math.max(0, end - 12000);
  const position = (n: number) => Math.max(0, Math.min(100, (n - start) / (end - start) * 100));
  return <section className="timeline-section" data-testid="timeline">
    <div className="section-heading"><h2><Activity size={15} /> Execution timeline</h2>
      <div className="legend"><span><i className="swatch waiting" />Queued</span><span><i className="swatch prefill" />Prefill</span><span><i className="swatch decode" />Decode</span>
        {engine.config.preemptionMode === 'recompute' && <span><i className="swatch preempted" />Preempted</span>}
        {engine.config.servingMode === 'disaggregated' && <><span><i className="swatch transfer_wait" />KV transfer</span><span><i className="swatch decode_wait" />Decode wait</span></>}
      </div></div>
    <div className="timeline-axis"><span>SEQUENCE</span><div>{[0, 1, 2, 3, 4].map(i => <span key={i}>{((start + (end - start) * i / 4) / 1000).toFixed(1)}s</span>)}</div></div>
    <div className="timeline-rows">{rows.map(r => <div className="timeline-row" key={r.id}>
      <button className="request-link" onClick={() => select(r.id)}>{r.id}<span className="muted">G{r.group ?? '-'}</span></button>
      <div className="timeline-track">
        {r.admittedAt !== undefined && r.admittedAt > start && <span className="timeline-span waiting" style={{ left: `${position(r.arrivedAt)}%`, width: `${position(r.admittedAt) - position(r.arrivedAt)}%` }} title={`${r.id} queue: ${r.admittedAt - r.arrivedAt}ms`} />}
        {r.spans.filter(s => TIMELINE_PHASES.includes(s.phase) && s.end >= start).map((s, i) => <span key={i} className={`timeline-span ${s.phase}`} style={{ left: `${position(s.start)}%`, width: `${Math.max(0.3, position(s.end) - position(s.start))}%` }} title={`${r.id} ${s.phase}: ${s.end - s.start}ms`} />)}
        {r.firstTokenAt !== undefined && r.firstTokenAt >= start && <i className="first-token" style={{ left: `${position(r.firstTokenAt)}%` }} title={`First token at ${r.firstTokenAt}ms`} />}
      </div>
    </div>)}</div>
    {!rows.length && <div className="empty-state">No execution samples</div>}
  </section>;
}

export function Inspector({ request, config }: { request?: Request; config: Config }) {
  return <section className="inspector">
    <div className="section-heading"><h2><Terminal size={15} /> Sequence inspector</h2><span className="mono">{request?.id ?? '--'}</span></div>
    {request ? <>
      <div className="inspector-grid">
        <div><span>STATE</span><b className={request.status}>{request.status}</b></div>
        <div><span>PRIORITY</span><b>{request.priority}</b></div>
        <div><span>TTFT</span><b>{request.firstTokenAt === undefined ? '--' : `${request.firstTokenAt - request.arrivedAt} ms`}</b></div>
        <div><span>SLO TTFT</span><b>{request.sloTTFT} ms {request.firstTokenAt !== undefined && (request.firstTokenAt - request.arrivedAt <= request.sloTTFT ? '✓' : '✗')}</b></div>
      </div>
      <div className="inspector-grid">
        <div><span>CACHED</span><b>{request.cachedTokens} tok</b></div>
        <div><span>PREEMPTIONS</span><b>{request.preemptions}</b></div>
        <div><span>RECOMPUTED</span><b>{request.recomputedTokens} tok</b></div>
        <div><span>TIER HIT</span><b>{request.tierHit ?? '--'}</b></div>
      </div>
      <div className="token-progress"><div><span>Prefill → context</span><b>{request.processed} / {request.promptTokens + request.generated}</b></div><div className="progress-track"><span className="prefill" style={{ width: `${request.processed / (request.promptTokens + request.generated) * 100}%` }} /></div></div>
      <div className="token-progress"><div><span>Decode</span><b>{request.generated} / {request.outputTokens}</b></div><div className="progress-track"><span className="decode" style={{ width: `${request.generated / request.outputTokens * 100}%` }} /></div></div>
      {request.transfer && <div className="transfer-detail"><span>KV TRANSFER</span><b>#{request.transfer.id}</b><span>{(request.transfer.bytes / 1048576).toFixed(1)} MiB</span>
        <span>queued {request.transfer.queuedAt}ms</span>{request.transfer.startedAt !== undefined && <span>started {request.transfer.startedAt}ms</span>}{request.transfer.finishedAt !== undefined && <span>done {request.transfer.finishedAt}ms</span>}</div>}
      {request.speculative && <div className="spec-tokens"><span>DRAFT VERIFY</span>{Array.from({ length: request.speculative.drafted }, (_, i) => <span key={i} className={i < request.speculative!.accepted ? 'accepted' : 'rejected'} title={i < request.speculative!.accepted ? 'Accepted draft token' : 'Discarded draft suffix'}>{i < request.speculative!.accepted ? <Check size={13} /> : <X size={13} />}</span>)}<ArrowRight size={12} /><b>commit</b></div>}
      <div className="decision-reason"><span className={`dot ${request.status}`} />{request.reason}{config.preemptionMode === 'recompute' && request.preemptions > 0 ? ' · will recompute on resume' : ''}</div>
    </> : <div className="empty-state">No selected sequence</div>}
  </section>;
}

export function Telemetry({ engine }: { engine: SimulationEngine }) {
  const m = engine.metrics;
  return <section className="telemetry">
    <div className="section-heading"><h2><Activity size={15} /> Output throughput</h2><span className="green mono">{fmt(m.tokensPerSecond)} tok/s</span></div>
    <Sparkline samples={engine.samples} field="tokens" color="#66d7b0" large />
    <div className="chart-labels"><span>-10s</span><span>SIMULATION TIME</span><span>now</span></div>
    <div className="telemetry-stats"><div><span>REQUESTS / SEC</span><b>{m.requestsPerSecond.toFixed(1)}</b></div><div><span>GOODPUT (SLO)</span><b>{m.goodput.toFixed(1)}</b></div><div><span>OUTPUT TOKENS</span><b>{fmt(m.outputTokens)}</b></div><div><span>DRAFT ACCEPTANCE</span><b>{m.drafted ? `${Math.round(m.accepted / m.drafted * 100)}%` : '--'}</b></div></div>
  </section>;
}

const EVENT_FILTERS = ['admit', 'wait', 'chunk', 'prefill', 'prefix', 'evict', 'watermark', 'budget', 'preempt', 'resume', 'transfer-queue', 'transfer-start', 'transfer-complete', 'restore-queue', 'restore-complete', 'verify', 'complete', 'reject', 'cancel', 'config'];

export function SchedulerLog({ engine }: { engine: SimulationEngine }) {
  const [filter, setFilter] = useState('all');
  const events = engine.events.filter(e => filter === 'all' || e.type === filter);
  return <section className="scheduler-log">
    <div className="section-heading"><h2><Terminal size={15} /> Scheduler events <span className="count">{engine.events.length}</span></h2>
      <select aria-label="Event filter" className="compact-select" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All events</option>{EVENT_FILTERS.map(e => <option key={e} value={e}>{e}</option>)}</select>
    </div>
    <div className="log-entries">{events.slice(0, 40).map(e => <div className="log-line" key={e.id}><time>{(e.at / 1000).toFixed(2)}</time><span className={`event-type ${e.type}`}>{e.type.toUpperCase()}</span><b>{e.requestId ?? 'SYS'}</b><span>{e.message}</span></div>)}
      {!events.length && <div className="empty-state">No matching events</div>}
    </div>
  </section>;
}

const COMPARE_ROWS: { key: keyof Metrics; label: string; lowerIsBetter?: boolean; digits?: number }[] = [
  { key: 'ttftP50', label: 'TTFT p50 (ms)', lowerIsBetter: true },
  { key: 'ttftP95', label: 'TTFT p95 (ms)', lowerIsBetter: true },
  { key: 'ttftP99', label: 'TTFT p99 (ms)', lowerIsBetter: true },
  { key: 'tpotP50', label: 'TPOT p50 (ms)', lowerIsBetter: true, digits: 1 },
  { key: 'tpotP99', label: 'TPOT p99 (ms)', lowerIsBetter: true, digits: 1 },
  { key: 'e2eP99', label: 'E2E p99 (ms)', lowerIsBetter: true },
  { key: 'tokensPerSecond', label: 'Throughput (tok/s)', digits: 0 },
  { key: 'requestsPerSecond', label: 'Throughput (req/s)', digits: 2 },
  { key: 'goodput', label: 'Goodput (SLO req/s)', digits: 2 },
  { key: 'sloAttainment', label: 'SLO attainment (%)', digits: 1 },
  { key: 'completed', label: 'Completed' },
  { key: 'kvUtilization', label: 'KV utilization (%)', digits: 0 },
  { key: 'prefixHitRate', label: 'Prefix hit rate (%)', digits: 0 },
  { key: 'evictions', label: 'Evictions' },
  { key: 'preemptions', label: 'Preemptions' },
  { key: 'recomputedTokens', label: 'Recomputed tokens', lowerIsBetter: true },
  { key: 'tokenBudgetUtilization', label: 'Budget utilization (%)', digits: 0 },
  { key: 'gpuUtilization', label: 'GPU utilization (%)', digits: 0 },
  { key: 'transfersCompleted', label: 'KV transfers done' },
  { key: 'networkBytes', label: 'Network bytes', digits: 0 },
];

export function CompareView({ captured, onCapture, onClear }: {
  captured: CapturedRun[]; onCapture: () => void; onClear: () => void;
}) {
  const cells = captured.map(c => c.metrics);
  const best = (row: (typeof COMPARE_ROWS)[number]) => {
    const values = cells.map(m => m[row.key] as number | null);
    const nums = values.filter((v): v is number => v !== null);
    if (!nums.length || !row.lowerIsBetter) return null;
    return Math.min(...nums);
  };
  const fmtCell = (row: (typeof COMPARE_ROWS)[number], v: number | null) =>
    v === null ? '--' : (row.digits !== undefined ? v.toFixed(row.digits) : fmt(v));
  return <section className="compare-section" data-testid="compare">
    <div className="section-heading"><h2><GitCompare size={15} /> Experiment compare <Tip text="Capture the current run, change one setting (scheduler policy, chunk size, topology...), run again and capture. Same seed and workload keep the comparison honest — all numbers are simulator outputs." /></h2>
      <div><button className="secondary" onClick={onCapture}>Capture current run</button>
        {captured.length > 0 && <button className="secondary" onClick={onClear}>Clear</button>}</div>
    </div>
    {captured.length === 0
      ? <div className="empty-state">Run a scenario, capture it, then change one knob and capture again.</div>
      : <div className="table-scroll"><table className="compare-table">
        <thead><tr><th>METRIC</th>{captured.map(c => <th key={c.label}>
          {c.label}
          <span className="subtle mono">{c.config.schedulerPolicy}/{c.config.servingMode === 'disaggregated' ? `${c.config.prefillGpuCount}P+${c.config.decodeGpuCount}D` : 'mono'} · chunk {c.config.prefillChunkSize || 'off'} · B{c.config.maxNumBatchedTokens} · wm {c.config.kvWatermark} · spec {c.config.speculativeDecoding ? c.config.specAcceptance : 'off'}</span>
        </th>)}</tr></thead>
        <tbody>{COMPARE_ROWS.map(row => {
          const bestValue = best(row);
          return <tr key={row.key}><td>{row.label}</td>{cells.map((m, i) => {
            const v = m[row.key] as number | null;
            const isBest = bestValue !== null && v === bestValue;
            return <td key={i} className={isBest ? 'best-cell' : ''}>{fmtCell(row, v)}</td>;
          })}</tr>;
        })}</tbody>
      </table></div>}
  </section>;
}
