import { useState } from 'react';
import { ListFilter } from 'lucide-react';
import type { SimulationEngine } from '../simulation/engine';

export function SchedulerInspector({ engine }: { engine: SimulationEngine }) {
  const [selected, setSelected] = useState('latest');
  const historical = engine.iterations.find(s => `${s.iteration}:${s.group}` === selected);
  const expired = selected !== 'latest' && !historical;
  const snapshot = historical ?? engine.iterations.at(-1);
  return <section className="scheduler-inspector" data-testid="scheduler-inspector">
    <div className="section-heading"><h2><ListFilter size={15} /> Scheduler inspector</h2><select aria-label="Scheduler iteration" className="compact-select" value={expired ? 'latest' : selected} onChange={e => setSelected(e.target.value)}>
      <option value="latest">Latest iteration</option>{engine.iterations.slice().reverse().map(s => <option key={`${s.iteration}:${s.group}`} value={`${s.iteration}:${s.group}`}>#{s.iteration} / G{s.group}</option>)}
    </select></div>
    {expired && <p className="comparison-note">Selected iteration left the retained window. Showing latest.</p>}
    {snapshot ? <>
      <div className="budget-title mono"><strong>{snapshot.budget.toLocaleString()} TOKEN BUDGET</strong><span>ITERATION {snapshot.iteration} / REPLICA {snapshot.group}</span></div>
      <div className="budget-bar" role="img" aria-label={`${snapshot.used} of ${snapshot.budget} tokens used`}>
        <span className="decode" style={{ width: `${snapshot.decodeTokens / snapshot.budget * 100}%` }} /><span className="prefill" style={{ width: `${snapshot.prefillTokens / snapshot.budget * 100}%` }} />
      </div>
      <div className="budget-legend mono"><span className="decode">Decode {snapshot.decodeTokens}</span><span className="prefill">Prefill {snapshot.prefillTokens}</span><span className="muted">Unused {snapshot.remaining}</span></div>
      <div className="scheduler-pressure"><span>KV pinned <b>{snapshot.pinned}/{snapshot.capacity}</b></span><span>KV reserved <b>{snapshot.reserved}/{snapshot.capacity}</b></span><span>Batch slots <b>{snapshot.slots}/{snapshot.maxSlots}</b></span></div>
      <div className="scheduler-decisions">
        <div><h3>Scheduled / {snapshot.scheduled.length}</h3><div className="decision-list">{snapshot.scheduled.map(a => <div key={a.requestId}><b>{a.requestId}</b><span className={a.phase}>{a.phase.toUpperCase()}</span><strong>{a.tokens} tok</strong><small>{a.priority}</small></div>)}{!snapshot.scheduled.length && <p className="muted">No tokens scheduled</p>}</div></div>
        <div><h3>Skipped / {snapshot.skipped.length}</h3><div className="decision-list">{snapshot.skipped.map(a => <div key={a.requestId}><b>{a.requestId}</b><span>{a.reason}</span><small>{a.priority}</small></div>)}{!snapshot.skipped.length && <p className="muted">No skipped requests</p>}</div></div>
      </div>
      <p className="comparison-note">Recent {engine.iterations.length} replica iterations retained · decode verification positions count against the budget · {engine.schedulerStats.mixedIterations} mixed iterations so far</p>
      <div className="scheduler-pressure"><span>Preemptions <b>{engine.preemptionStats.count}</b></span><span>Recomputed <b>{engine.preemptionStats.recomputedTokens} tokens</b></span><span>Recompute service <b>{engine.preemptionStats.overheadMs} sequence-ms</b></span></div>
    </> : <div className="empty-state">Step the simulation to inspect a decision.</div>}
  </section>;
}
