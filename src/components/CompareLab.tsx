import { memo, useEffect, useMemo, useState } from 'react';
import { FlaskConical, Play, Pause, RotateCcw } from 'lucide-react';
import { Comparison, delta, PRIORITY_STRATEGIES, STRATEGIES, tpStrategies } from '../simulation/comparison';
import type { ComparisonMetrics, ComparisonSample } from '../simulation/comparison';
import { buildWorkload, DEFAULT_WORKLOAD, fingerprint } from '../simulation/workload';
import type { WorkloadConfig } from '../simulation/workload';
import { NumberField, Tip } from './Controls';
import type { Config } from '../simulation/types';
import { experimentReport, explainMetric, markdownReport } from '../simulation/report';

const rows: { key: keyof ComparisonMetrics; name: string; unit: string; lower?: boolean; tip: string }[] = [
  { key: 'ttft', name: 'TTFT', unit: 'ms', lower: true, tip: 'Mean arrival-to-first-output latency. Only requests with a first token contribute.' },
  { key: 'tpot', name: 'TPOT', unit: 'ms/tok', lower: true, tip: 'Token-weighted spacing after the first output token; same-step speculative output has zero internal spacing.' },
  { key: 'tokensPerSecond', name: 'Throughput', unit: 'tok/s', tip: 'Total output divided by this strategy’s elapsed simulation time, from time zero to completion.' },
  { key: 'requestsPerSecond', name: 'Req/s', unit: 'req/s', tip: 'Completed requests divided by elapsed time. Rejected requests do not contribute.' },
  { key: 'gpuUtilization', name: 'GPU Util', unit: '%', tip: 'Time-weighted synthetic occupancy. This is not hardware telemetry; higher utilization is not always better.' },
  { key: 'kvUtilization', name: 'KV Util', unit: '%', tip: 'Time-weighted occupied physical pages, including retained prefix pages. Higher is not necessarily better.' },
  { key: 'prefixHitRate', name: 'Prefix Hit', unit: '%', tip: 'Prefix-eligible admissions reusing one or more pages / prefix-eligible cache lookups.' },
  { key: 'queueTime', name: 'Queue Time', unit: 'ms', lower: true, tip: 'Initial plus preemption waiting time / distinct admitted requests.' },
  { key: 'completed', name: 'Completed', unit: 'req', tip: 'Lifetime completed requests. Check rejection counts before interpreting results.' },
];
const charts: { key: keyof Omit<ComparisonSample, 'at'>; name: string; unit: string }[] = [
  { key: 'queue', name: 'Queue depth', unit: 'requests' },
  { key: 'tokens', name: 'Output throughput', unit: 'tok/s · trailing 1 s' },
  { key: 'gpu', name: 'GPU utilization', unit: '%' },
  { key: 'kv', name: 'KV utilization', unit: '%' },
  { key: 'active', name: 'Active requests', unit: 'requests' },
];
const format = (n: number | null) => n === null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 1 });

function OverlayChart({ lab, field, name, unit }: { lab: Comparison; field: keyof Omit<ComparisonSample, 'at'>; name: string; unit: string }) {
  const max = field === 'gpu' || field === 'kv' ? 100 : Math.max(1, ...lab.experiments.flatMap(e => e.samples.map(s => s[field])));
  const end = Math.max(1000, lab.now);
  return <section className="overlay-chart">
    <div className="section-heading"><h3>{name}</h3><span className="subtle">{unit}</span></div>
    <svg viewBox="0 0 600 120" role="img" aria-label={`${name}: overlaid strategies`} preserveAspectRatio="none">
      {[0, 1, 2, 3].map(i => <line key={i} x1="0" x2="600" y1={10 + i * 32} y2={10 + i * 32} stroke="#29343b" />)}
      {lab.experiments.map((e, i) => <polyline key={e.strategy.id} data-strategy={e.strategy.id} fill="none" stroke={e.strategy.color} strokeWidth="2" strokeDasharray={['6 3', undefined, '2 3', '9 3 2 3'][i]}
        points={e.samples.map(s => `${s.at / end * 600},${106 - s[field] / max * 96}`).join(' ')} />)}
    </svg>
    <div className="chart-labels"><span>0 s</span><span>0–{format(max)} {unit.split(' ')[0]}</span><span>{(end / 1000).toFixed(1)} s</span></div>
  </section>;
}

export const CompareLab = memo(function CompareLab({ visible, expert }: { visible: boolean; expert: boolean }) {
  const [builder, setBuilder] = useState<WorkloadConfig>(DEFAULT_WORKLOAD);
  const [builderExpanded, setBuilderExpanded] = useState(false);
  const [trace, setTrace] = useState(() => buildWorkload(DEFAULT_WORKLOAD));
  const [traceSeed, setTraceSeed] = useState(DEFAULT_WORKLOAD.seed);
  const traceFingerprint = useMemo(() => fingerprint(trace), [trace]);
  const [lab, setLab] = useState(() => new Comparison(trace));
  const [running, setRunning] = useState(false);
  const [baseline, setBaseline] = useState('static');
  const [experimentMode, setExperimentMode] = useState('strategies');
  const [runtimeConfig, setRuntimeConfig] = useState<Partial<Config>>({ interconnect: 'nvlink', bandwidthGBps: 300, latencyUs: 5 });
  const [explanation, setExplanation] = useState<{ id: string; metric: keyof ComparisonMetrics } | null>(null);
  const [, render] = useState(0);
  useEffect(() => {
    if (!running || !visible) return;
    const timer = window.setInterval(() => {
      // Fixed simulation clock; four engines update the display at only 10 Hz.
      lab.step(25);
      render(n => n + 1);
      if (lab.done) setRunning(false);
    }, 100);
    return () => window.clearInterval(timer);
  }, [lab, running, visible]);
  const patch = <K extends keyof WorkloadConfig>(key: K, value: WorkloadConfig[K]) => setBuilder(b => ({ ...b, [key]: value }));
  const base = lab.experiments.find(e => e.strategy.id === baseline) ?? lab.experiments[0];
  const strategiesFor = (mode: string) => mode === 'tp' ? tpStrategies() : mode === 'priority' ? PRIORITY_STRATEGIES : STRATEGIES;
  function generate() {
    const next = buildWorkload(builder);
    setTrace(next); setTraceSeed(builder.seed); setLab(new Comparison(next, runtimeConfig, builder.seed, strategiesFor(experimentMode))); setRunning(false);
    setBuilderExpanded(false);
  }
  function exportReport(markdown: boolean) {
    const report = experimentReport(lab, baseline);
    const url = URL.createObjectURL(new Blob([markdown ? markdownReport(report) : JSON.stringify(report, null, 2)], { type: markdown ? 'text/markdown' : 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `inferenceos-experiment.${markdown ? 'md' : 'json'}`; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <main className="compare-lab" hidden={!visible}>
    <div className="compare-heading"><div><span className="eyebrow"><FlaskConical size={14} /> EXPERIMENT WORKSPACE</span><h2>{experimentMode === 'tp' ? 'Find the cost of another rank.' : experimentMode === 'priority' ? 'Who gets scheduled first?' : 'One workload. Four execution strategies.'}</h2><p>Freeze the arrivals, change the runtime, inspect the difference.</p></div><span className="simulation-badge">SIMULATED / single seed</span></div>
    <div className="compare-layout">
      <aside className={`workload-builder ${builderExpanded ? 'expanded' : ''}`}>
        <button className="secondary full workload-collapse" aria-expanded={builderExpanded} onClick={() => setBuilderExpanded(!builderExpanded)}>Workload settings · {builderExpanded ? 'Hide' : 'Edit'}</button>
        <div className="builder-fields">
        <div className="section-heading"><h2>Workload builder</h2><Tip text="Generate materializes an immutable trace. Every experiment replays the same entries with the same seed." /></div>
        <div className="two-fields"><NumberField label="Request count" value={builder.count} min={1} max={256} onChange={n => patch('count', n)} /><NumberField label="Workload seed" value={builder.seed} min={0} max={4294967295} onChange={n => patch('seed', n)} /></div>
        <label className="field"><span>Arrival pattern</span><select aria-label="Arrival pattern" value={builder.pattern} onChange={e => patch('pattern', e.target.value as WorkloadConfig['pattern'])}>{['uniform', 'burst', 'poisson', 'prefix-heavy', 'long-context', 'mixed'].map(p => <option key={p} value={p}>{p}</option>)}</select></label>
        <NumberField label="Arrival interval" value={builder.intervalMs} min={0} max={2000} unit="ms" onChange={n => patch('intervalMs', n)} />
        {(['prompt', 'output'] as const).map(kind => <div key={kind}>
          <label className="field"><span>{kind} length distribution</span><select aria-label={`${kind} distribution`} value={builder[`${kind}Distribution`]} onChange={e => patch(`${kind}Distribution`, e.target.value as WorkloadConfig['promptDistribution'])}>{['fixed', 'uniform', 'bimodal'].map(d => <option key={d}>{d}</option>)}</select></label>
          <div className="two-fields"><NumberField label={`${kind} min`} value={builder[`${kind}Min`]} min={1} max={kind === 'prompt' ? 8192 : 1024} onChange={n => patch(`${kind}Min`, n)} /><NumberField label={`${kind} max`} value={builder[`${kind}Max`]} min={1} max={kind === 'prompt' ? 8192 : 1024} onChange={n => patch(`${kind}Max`, n)} /></div>
        </div>)}
        {([{ key: 'prefixReuse', name: 'Prefix reuse ratio' }, { key: 'longContextRatio', name: 'Long-context ratio' }, { key: 'burstiness', name: 'Burstiness' }] as const).map(({ key, name }) => <label key={key} className="range-field"><span>{name}<b>{Math.round(builder[key] * 100)}%</b></span><input aria-label={name} type="range" min="0" max="1" step=".05" value={builder[key]} onChange={e => patch(key, Number(e.target.value))} /></label>)}
        <button className="secondary full" onClick={generate}>Generate workload</button>
        </div>
        <div className="trace-identity"><span className="eyebrow">FROZEN TRACE</span><strong>{traceFingerprint}</strong><span>{trace.length} requests · seed {traceSeed}</span><span>Last arrival {(trace.at(-1)!.arrival / 1000).toFixed(2)} s</span></div>
        {expert && <details><summary>Inspect request trace</summary><div className="trace-preview mono">{trace.map(r => <div key={r.id}>{r.id} +{r.arrival}ms · {r.promptTokens}/{r.outputTokens} · {r.prefix} · {r.priority}</div>)}</div></details>}
      </aside>
      <div className="comparison-results">
        <div className="experiment-toolbar">
          <select className="experiment-mode" aria-label="Experiment mode" value={experimentMode} onChange={e => {
            const mode = e.target.value; setExperimentMode(mode);
            const strategies = strategiesFor(mode);
            setLab(new Comparison(trace, runtimeConfig, traceSeed, strategies)); setBaseline(strategies[0].id); setRunning(false);
          }}><option value="strategies">4-way strategies</option><option value="priority">FCFS vs Priority</option><option value="tp">TP scaling</option></select>
          <button className="primary" disabled={lab.done} onClick={() => setRunning(!running)}>{running ? <Pause size={13} /> : <Play size={13} />}{running ? 'Pause comparison' : 'Run comparison'}</button>
          <button className="secondary" aria-label="Reset comparison" onClick={() => { setLab(new Comparison(trace, runtimeConfig, traceSeed, strategiesFor(experimentMode))); setRunning(false); }}><RotateCcw size={13} /></button>
          <span className="mono" data-testid="comparison-status">{lab.timedOut ? 'TIME LIMIT · partial results' : lab.done ? 'COMPLETE' : running ? 'RUNNING' : 'READY'} · {(lab.now / 1000).toFixed(1)} s</span>
          <label className="baseline-label">Baseline<select aria-label="Comparison baseline" value={baseline} onChange={e => setBaseline(e.target.value)}>{lab.experiments.map(e => <option key={e.strategy.id} value={e.strategy.id}>{e.strategy.name}</option>)}</select></label>
        </div>
        {experimentMode === 'tp' && <div className="tp-lab-config">
          <label className="field"><span>Scaling interconnect</span><select aria-label="Scaling interconnect" value={runtimeConfig.interconnect} onChange={e => {
            const c = { ...runtimeConfig, interconnect: e.target.value as Config['interconnect'] };
            setRuntimeConfig(c); setLab(new Comparison(trace, c, traceSeed, tpStrategies())); setRunning(false);
          }}><option value="nvlink">NVLink</option><option value="pcie">PCIe</option><option value="custom">Custom</option></select></label>
          {runtimeConfig.interconnect === 'custom' && <><NumberField label="Scaling bandwidth" min={0.1} max={1000} value={runtimeConfig.bandwidthGBps!} unit="GB/s" onChange={n => {
            const c = { ...runtimeConfig, bandwidthGBps: n }; setRuntimeConfig(c); setLab(new Comparison(trace, c, traceSeed, tpStrategies())); setRunning(false);
          }} /><NumberField label="Scaling latency" min={0} max={10000} value={runtimeConfig.latencyUs!} unit="µs" onChange={n => {
            const c = { ...runtimeConfig, latencyUs: n }; setRuntimeConfig(c); setLab(new Comparison(trace, c, traceSeed, tpStrategies())); setRunning(false);
          }} /></>}
          <p className="comparison-note">One replica per run, identical KV capacity. TP1/2/4/8 use 1/2/4/8 GPUs respectively: varying hardware budget, not equal-cost efficiency.</p>
        </div>}
        <div className="comparison-table-scroll"><table className="comparison-table"><thead><tr><th>RESULT / Δ BASELINE</th>{lab.experiments.map(e => <th key={e.strategy.id} style={{ color: e.strategy.color }}><i style={{ background: e.strategy.color }} />{e.strategy.name}<small>{e.finishedAt === null ? 'in progress' : `${(e.finishedAt / 1000).toFixed(2)} s to drain`}</small></th>)}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.key}><th>{row.name} <Tip text={row.tip} /><small>{row.unit}</small></th>{lab.experiments.map(e => {
            const value = e.metrics[row.key], change = delta(value, base.metrics[row.key]);
            const directional = row.lower || row.key === 'tokensPerSecond' || row.key === 'requestsPerSecond';
            return <td key={e.strategy.id} data-testid={`metric-${e.strategy.id}-${row.key}`}><button className="metric-explain" aria-label={`Explain ${e.strategy.name} ${row.name}`} onClick={() => setExplanation({ id: e.strategy.id, metric: row.key })}>{format(value)}</button><span className={change !== null && directional ? (row.lower ? change < 0 : change > 0) ? 'green' : change ? 'waiting' : 'muted' : 'muted'}>{e === base ? 'baseline' : change === null ? 'Δ n/a' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}</span></td>;
          })}</tr>)}</tbody></table></div>
        <p className="comparison-scroll-hint">Scroll the table horizontally to compare all strategies →</p>
        <p className="comparison-note">Descriptive results from an illustrative model; no statistical significance or hardware accuracy implied. {lab.experiments.map(e => `${e.strategy.name}: ${e.metrics.rejected} rejected`).join(' · ')}</p>
        <div className="report-actions"><span className="subtle">Click any result to explain why.</span><button className="secondary" disabled={!lab.done} onClick={() => exportReport(false)}>Export Experiment Report</button><button className="secondary" disabled={!lab.done} onClick={() => exportReport(true)}>Markdown</button></div>
        {explanation && lab.experiments.some(e => e.strategy.id === explanation.id) && <section className="explain-panel" aria-label="Explain why">
          <div className="section-heading"><h2>Why did {rows.find(r => r.key === explanation.metric)?.name} change?</h2><span className="subtle">DETERMINISTIC / SIMULATED</span></div>
          <ul>{explainMetric(lab.experiments.find(e => e.strategy.id === explanation.id)!, base, explanation.metric).map(line => <li key={line}>{line}</li>)}</ul>
        </section>}
        {experimentMode === 'tp' && <div className="tp-summary">{lab.experiments.map(e => {
          const s = e.engine.tpStats, total = s.computeMs + s.communicationMs;
          return <div key={e.strategy.id}><strong style={{ color: e.strategy.color }}>{e.strategy.name}</strong><span>Compute {format(s.computeMs)} ms</span><span>Communication {format(s.communicationMs)} ms</span><b>{format(total ? s.communicationMs / total * 100 : 0)}% communication</b><div className="budget-bar"><span className="prefill" style={{ width: `${total ? s.computeMs / total * 100 : 0}%` }} /><span className="comm" style={{ flex: 1 }} /></div></div>;
        })}</div>}
        <div className="strategy-legend">{lab.experiments.map((e, i) => <span key={e.strategy.id}><i style={{ borderColor: e.strategy.color, borderTopStyle: ['dashed', 'solid', 'dotted', 'dashed'][i] as 'solid' }} />{e.strategy.name}</span>)}<span className="muted">Shared simulation time axis</span></div>
        <div className="comparison-charts">{charts.map(c => <OverlayChart key={c.key} lab={lab} field={c.key} name={c.name} unit={c.unit} />)}</div>
      </div>
    </div>
  </main>;
});
