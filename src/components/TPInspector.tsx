import { Network } from 'lucide-react';
import type { SimulationEngine } from '../simulation/engine';

export function TPInspector({ engine }: { engine: SimulationEngine }) {
  const stats = engine.tpStats, total = stats.computeMs + stats.communicationMs;
  return <section className="tp-inspector">
    <div className="section-heading"><h2><Network size={15} /> Tensor parallel execution</h2><span className="subtle">Illustrative model · {engine.config.interconnect.toUpperCase()}</span></div>
    <div className="scheduler-pressure"><span>Compute <b>{stats.computeMs.toFixed(1)} ms</b></span><span>Communication <b>{stats.communicationMs.toFixed(1)} ms</b></span><span>Comm ratio <b>{total ? (stats.communicationMs / total * 100).toFixed(1) : 0}%</b></span><span>Collectives <b>{(stats.collectiveBytes / 1e6).toFixed(1)} MB</b></span></div>
    {engine.pools.map((_, group) => {
      const flight = engine.inFlight[group];
      const snapshot = flight?.snapshot ?? engine.iterations.findLast(s => s.group === group && s.used);
      const cost = snapshot?.cost;
      return <div className="tp-stage-group" key={group}>
        <div className="section-heading"><h3>Replica {group} · {flight ? 'executing' : 'last batch'} · #{snapshot?.iteration ?? '—'}</h3><span className="subtle">{cost?.totalMs.toFixed(2) ?? '0'} ms modeled / 20 ms clock</span></div>
        {engine.workers.filter(w => w.group === group).map(w => <div className="tp-stage-row" key={w.id}><span className="mono">GPU{w.id} / R{w.rank}</span><div className="tp-stage-track">
          {cost?.stages.map((s, i) => <span key={i} className={s.kind} style={{ flexGrow: s.ms, minWidth: s.ms ? 2 : 0, display: s.ms ? undefined : 'none' }} title={`${s.name}: ${s.ms.toFixed(3)} ms`}>{s.kind === 'compute' ? i === 0 ? 'ATTN' : 'MLP' : 'ALLREDUCE'}</span>)}
          {flight && cost && <i className="tp-cursor" style={{ left: `${Math.min(100, flight.elapsed / cost.totalMs * 100)}%` }} />}
        </div></div>)}
      </div>;
    })}
    <p className="comparison-note">Synchronized ranks execute one batch. Totals sum replica service time, not GPU-rank time. Collective volume sums transmitted bytes across ranks. Two collectives per illustrative layer; no compute/communication overlap.</p>
  </section>;
}
