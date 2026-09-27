import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Box, Download, GitBranch, GitCompare, LayoutDashboard, Pause, Play, RotateCcw, SkipForward, SlidersHorizontal, Terminal } from 'lucide-react';
import { Controls } from './components/Controls';
import { BudgetBar, Cache, CompareView, Inspector, MetricsStrip, Queue, SchedulerLog, Telemetry, Timeline, Workers, type CapturedRun } from './components/Views';
import { SimulationEngine } from './simulation/engine';
import { createScenario, SCENARIOS } from './simulation/scenarios';
import type { Config, RequestInput } from './simulation/types';
import type { TrafficSpec } from './simulation/workload';
import { parseTrace, traceToScenario } from './simulation/trace';

const SCENARIO_GROUPS = Array.from(new Set(SCENARIOS.map(s => s.group)));

export default function App() {
  const [engine, setEngine] = useState(() => createScenario('continuous-batching'));
  const [, render] = useState(0);
  const [scenario, setScenario] = useState('continuous-batching');
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [traffic, setTraffic] = useState(true);
  const [rate, setRate] = useState(2);
  const [input, setInput] = useState<RequestInput>(SCENARIOS[0].input);
  const [selected, setSelected] = useState<string | null>('R001');
  const [notice, setNotice] = useState('');
  const [generation, setGeneration] = useState(0);
  const [view, setView] = useState('runtime');
  const [controlsOpen, setControlsOpen] = useState(false);
  const [captured, setCaptured] = useState<CapturedRun[]>([]);
  const clockCredit = useRef(0);
  const refresh = () => render(n => n + 1);
  const currentScenario = SCENARIOS.find(s => s.id === scenario) ?? SCENARIOS[0];

  const advance = (count: number) => {
    engine.step(count);
    refresh();
  };
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      clockCredit.current += 40 * speed;
      const ticks = Math.floor(clockCredit.current / 20);
      clockCredit.current %= 20;
      if (ticks) advance(ticks);
    }, 40);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, running, speed]);

  function replace(next: SimulationEngine, trafficEnabled = true) {
    setEngine(next); setGeneration(n => n + 1); setSelected(next.requests[0]?.id ?? null);
    clockCredit.current = 0; setNotice(''); setCaptured([]);
    setTraffic(trafficEnabled);
  }
  function chooseScenario(id: string) {
    const s = SCENARIOS.find(s => s.id === id)!;
    setScenario(id); setInput({ ...s.input }); setRate(s.rate);
    replace(createScenario(id), true);
  }
  function apply(config: Config) {
    const next = new SimulationEngine(config);
    const s = SCENARIOS.find(s => s.id === scenario)!;
    if (s.requests?.length) {
      next.setTraffic({ enabled: true, arrival: 'trace', requests: s.requests, prompt: { kind: 'fixed', value: s.input.promptTokens }, output: { kind: 'fixed', value: s.input.outputTokens }, prefix: s.input.prefix });
    } else {
      if (s.count) next.burst(s.count, input);
      next.setTraffic({ enabled: traffic, arrival: s.arrival ?? 'constant', rate, prompt: { kind: 'fixed', value: input.promptTokens }, output: { kind: 'fixed', value: input.outputTokens }, prefix: input.prefix, prefixReuseProbability: 1, priorityMix: s.priorityMix ?? { low: 0, normal: 1, high: 0 }, ...(s.traffic ?? {}) });
    }
    replace(next, traffic);
  }
  function add(count: number) {
    const requests = count === 1 ? [engine.enqueue(input)] : engine.burst(count, input);
    const rejected = requests.filter(r => r.status === 'rejected').length;
    setNotice(rejected ? `${rejected} rejected: context or queue limit` : count === 1 ? `${requests[0].id} queued` : `${requests.length} requests queued`);
    setSelected(requests[0].id); refresh();
  }
  function setTrafficEnabled(b: boolean) {
    setTraffic(b);
    engine.updateTraffic({ enabled: b } as Partial<TrafficSpec>);
    refresh();
  }
  function setRateLive(n: number) {
    setRate(n);
    engine.updateTraffic({ rate: n, arrival: engine.workload?.current.arrival === 'trace' ? 'trace' : engine.workload?.current.arrival ?? 'constant' });
    refresh();
  }
  function exportScenario() {
    const payload = {
      version: 1 as const,
      name: `${currentScenario.name} (exported)`,
      seed: 73,
      config: engine.config,
      traffic: engine.workload?.current
        ? { ...engine.workload.current, enabled: traffic, rate }
        : { enabled: false },
      notes: currentScenario.learn,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'inferenceos-scenario.json'; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function importScenario(file: File) {
    file.text().then(text => {
      try {
        const trimmed = text.trim();
        // Workload traces (JSONL lines or a JSON array) replay real request shapes.
        const isTrace = file.name.endsWith('.jsonl') || trimmed.startsWith('[');
        if (isTrace) {
          const parsed = parseTrace(text);
          const built = traceToScenario(parsed, { name: `trace:${file.name}` });
          const next = new SimulationEngine(built.config ?? {}, built.seed ?? 73);
          next.setTraffic(built.traffic ?? { enabled: false });
          setScenario('imported-trace');
          replace(next, true);
          setNotice(`Imported trace: ${parsed.requests.length} requests`);
          return;
        }
        const parsed = JSON.parse(trimmed) as { version: number; config?: Partial<Config>; traffic?: Partial<TrafficSpec>; seed?: number };
        if (parsed.version !== 1) { setNotice('Unsupported scenario version'); return; }
        const next = new SimulationEngine(parsed.config ?? {}, parsed.seed ?? 73);
        next.setTraffic(parsed.traffic ?? { enabled: false });
        setScenario('imported');
        replace(next, parsed.traffic?.enabled ?? false);
        setNotice(`Imported ${file.name}`);
      } catch (err) {
        setNotice(err instanceof Error ? err.message.split('\n')[0] : 'Invalid scenario JSON');
      }
    });
  }
  function exportRun() {
    const blob = new Blob([JSON.stringify(engine.exportRun(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'inferenceos-run.json'; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function captureRun() {
    setCaptured(prev => [...prev.slice(0, 3), {
      label: `Run ${String.fromCharCode(65 + Math.min(prev.length, 3))}`,
      config: engine.config, metrics: engine.metrics, at: engine.now,
    }]);
  }
  const m = engine.metrics;
  const selectedRequest = engine.requests.find(r => r.id === selected);
  return <div className={`app-shell ${controlsOpen ? 'controls-open' : ''}`}>
    <header className="topbar">
      <div className="brand"><div className="brand-icon"><Box size={23} /></div><div><h1>InferenceOS <span>Lab</span></h1><div className="brand-subtitle">DETERMINISTIC LLM SERVING SIMULATOR</div></div><span className="build-tag">v2</span></div>
      <div className="topbar-right"><span className="simulation-badge"><i className="live-dot" /> SIMULATED · NOT A BENCHMARK</span><button className="icon-button mobile-controls" title="Control plane" aria-label="Toggle control plane" aria-pressed={controlsOpen} onClick={() => { setControlsOpen(!controlsOpen); window.scrollTo(0, 0); }}><SlidersHorizontal size={17} /></button><button className="icon-button" onClick={exportRun} title="Export run (config, metrics, observations, events)" aria-label="Export run"><Download size={17} /></button></div>
    </header>
    <div className="workspace-bar">
      <nav aria-label="Workspace views">
        <button className={view === 'runtime' ? 'active-tab' : ''} onClick={() => setView('runtime')}><LayoutDashboard size={14} /> Runtime</button>
        <button className={view === 'trace' ? 'active-tab' : ''} onClick={() => setView('trace')}><Terminal size={14} /> Trace</button>
        <button className={view === 'compare' ? 'active-tab' : ''} onClick={() => setView('compare')}><GitCompare size={14} /> Compare</button>
      </nav>
      <div className="scenario-select"><GitBranch size={14} /><select aria-label="Scenario" value={scenario} onChange={e => chooseScenario(e.target.value)}>
        {SCENARIO_GROUPS.map(g => <optgroup key={g} label={g}>{SCENARIOS.filter(s => s.group === g).map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</optgroup>)}
      </select></div>
      <div className="playback"><span className={`run-state ${running ? 'green' : 'muted'}`}><i className={running ? 'live-dot' : 'paused-dot'} />{running ? 'Running' : 'Paused'}</span><time className="sim-time" data-testid="sim-time">{(engine.now / 1000).toFixed(2)} s</time>
        <div className="playback-buttons"><button className="icon-button" title={running ? 'Pause simulation' : 'Resume simulation'} aria-label={running ? 'Pause simulation' : 'Resume simulation'} onClick={() => setRunning(!running)}>{running ? <Pause size={15} /> : <Play size={15} />}</button>
          <button className="icon-button" title="Step one 20 ms iteration" aria-label="Step 20 milliseconds" onClick={() => { setRunning(false); advance(1); }}><SkipForward size={15} /></button>
          <button className="icon-button" title="Reset current configuration" aria-label="Reset simulation" onClick={() => apply(engine.config)}><RotateCcw size={14} /></button></div>
        <select aria-label="Simulation speed" className="speed-select" value={speed} onChange={e => setSpeed(Number(e.target.value))}>{[0.25, 0.5, 1, 2, 4].map(s => <option key={s} value={s}>{s}x</option>)}</select>
      </div>
    </div>
    <div className="workspace">
      <Controls key={generation} config={engine.config} input={input} setInput={setInput} add={add} notice={notice} apply={apply}
        setFeature={(key, value) => { engine.setFeatures({ [key]: value } as Partial<Config>); refresh(); }}
        traffic={traffic} setTraffic={setTrafficEnabled} rate={rate} setRate={setRateLive}
        onExportScenario={exportScenario} onImportScenario={importScenario} />
      <main>
        <MetricsStrip engine={engine} />
        <div className="runtime-heading"><div><Activity size={15} /><h2>{view === 'runtime' ? 'Runtime overview' : view === 'trace' ? 'Execution trace' : 'Experiment compare'}</h2><span className="subtle">iteration {engine.now / 20}</span></div>
          <span className="subtle mono">{engine.config.servingMode === 'disaggregated' ? `DISAGGREGATED ${engine.config.prefillGpuCount}P+${engine.config.decodeGpuCount}D` : 'MONOLITHIC'} / {engine.config.schedulerPolicy.toUpperCase()}</span></div>
        <div className="scenario-banner" data-testid="scenario-banner">
          <b>{currentScenario.name}</b><span>{currentScenario.learn}</span>
        </div>
        <div className="pipeline">
          <div><i className="dot waiting" /><span>Queued</span><b>{m.waiting}</b></div><ArrowRight size={13} />
          <div><i className="dot prefill" /><span>Prefill</span><b>{engine.requests.filter(r => r.status === 'prefill').length}</b></div><ArrowRight size={13} />
          <div><i className="dot decode" /><span>Decode</span><b>{engine.requests.filter(r => r.status === 'decode').length}</b></div>
          {engine.config.servingMode === 'disaggregated' && <><ArrowRight size={13} /><div><i className="dot transfer_wait" /><span>KV transfer</span><b>{m.transfersActive + m.transfersQueued}</b></div></>}
          <ArrowRight size={13} />
          <div><i className="dot completed" /><span>Completed</span><b>{m.completed}</b></div>
          <span className="pipeline-rejected">{m.rejected} rejected / {m.cancelled} cancelled / {m.preempted} preempted</span>
        </div>
        {view === 'compare' ? <div className="runtime-grid single"><CompareView captured={captured} onCapture={captureRun} onClear={() => setCaptured([])} /></div>
          : view === 'runtime' ? <>
            <div className="runtime-grid"><div className="left-column"><Workers engine={engine} select={setSelected} /><Queue engine={engine} selected={selected} select={setSelected} cancel={id => { engine.cancel(id); refresh(); }} /></div>
              <Cache engine={engine} selected={selected} select={setSelected} /></div>
            <div className="bottom-grid"><Timeline engine={engine} select={setSelected} /><Inspector request={selectedRequest} config={engine.config} /></div>
            <div className="bottom-grid"><SchedulerLog engine={engine} /><div className="stacked-telemetry"><BudgetBar engine={engine} /><Telemetry engine={engine} /></div></div>
          </> : <div className="trace-view"><Timeline engine={engine} select={setSelected} /><div className="bottom-grid"><SchedulerLog engine={engine} /><Inspector request={selectedRequest} config={engine.config} /></div><div className="bottom-grid"><BudgetBar engine={engine} /><Telemetry engine={engine} /></div></div>}
        <footer className="statusbar"><span><i className="live-dot" /> ENGINE CONNECTED</span><span>20 ms step · seed 73</span><span>Illustrative cost models · no real hardware</span><span className="statusbar-right">vLLM-inspired execution model</span></footer>
      </main>
    </div>
  </div>;
}
