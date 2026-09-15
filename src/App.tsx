import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Box, Download, GitBranch, LayoutDashboard, Pause, Play, RotateCcw, SkipForward, SlidersHorizontal, Terminal } from 'lucide-react';
import { Controls } from './components/Controls';
import { Cache, Inspector, MetricsStrip, Queue, SchedulerLog, Telemetry, Timeline, Workers } from './components/Views';
import { SimulationEngine } from './simulation/engine';
import { createScenario, SCENARIOS } from './simulation/scenarios';
import type { Config, RequestInput } from './simulation/types';

export default function App() {
  const [engine, setEngine] = useState(() => createScenario('continuous'));
  const [, render] = useState(0);
  const [scenario, setScenario] = useState('continuous');
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
  const arrivalCredit = useRef(0);
  const clockCredit = useRef(0);
  const refresh = () => render(n => n + 1);

  const advance = (count: number) => {
    for (let i = 0; i < count; i++) {
      if (traffic) {
        arrivalCredit.current += rate * 0.02;
        if (arrivalCredit.current >= 1) {
          if (engine.metrics.waiting < 128) engine.burst(1, input);
          arrivalCredit.current -= 1;
        }
      }
      engine.step();
    }
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
  }, [engine, running, speed, traffic, rate, input]);

  function replace(next: SimulationEngine) {
    setEngine(next); setGeneration(n => n + 1); setSelected(next.requests[0]?.id ?? null);
    arrivalCredit.current = 0; clockCredit.current = 0; setNotice('');
  }
  function chooseScenario(id: string) {
    const s = SCENARIOS.find(s => s.id === id)!;
    setScenario(id); setInput({ ...s.input }); setRate(s.rate); setTraffic(true);
    replace(createScenario(id));
  }
  function apply(config: Config) {
    const next = new SimulationEngine(config);
    next.burst(SCENARIOS.find(s => s.id === scenario)!.count, input);
    replace(next);
  }
  function add(count: number) {
    const requests = count === 1 ? [engine.enqueue(input)] : engine.burst(count, input);
    const rejected = requests.filter(r => r.status === 'rejected').length;
    setNotice(rejected ? `${rejected} rejected: context or queue limit` : count === 1 ? `${requests[0].id} queued` : `${requests.length} requests queued`);
    setSelected(requests[0].id); refresh();
  }
  function exportTrace() {
    const blob = new Blob([JSON.stringify({ schemaVersion: 1, simulatedMs: engine.now, config: engine.config, metrics: engine.metrics, requests: engine.requests, events: engine.events, samples: engine.samples }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'inferenceos-trace.json'; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const m = engine.metrics;
  const selectedRequest = engine.requests.find(r => r.id === selected);
  return <div className={`app-shell ${controlsOpen ? 'controls-open' : ''}`}>
    <header className="topbar">
      <div className="brand"><div className="brand-icon"><Box size={23} /></div><div><h1>InferenceOS <span>Playground</span></h1><div className="brand-subtitle">LLM INFERENCE RUNTIME</div></div><span className="build-tag">v0.1</span></div>
      <div className="topbar-right"><span className="simulation-badge"><i className="live-dot" /> SIMULATED</span><button className="icon-button mobile-controls" title="Control plane" aria-label="Toggle control plane" aria-pressed={controlsOpen} onClick={() => { setControlsOpen(!controlsOpen); window.scrollTo(0, 0); }}><SlidersHorizontal size={17} /></button><button className="icon-button" onClick={exportTrace} title="Export recent trace and lifetime metrics" aria-label="Export trace"><Download size={17} /></button></div>
    </header>
    <div className="workspace-bar">
      <nav aria-label="Workspace views"><button className={view === 'runtime' ? 'active-tab' : ''} onClick={() => setView('runtime')}><LayoutDashboard size={14} /> Runtime</button><button className={view === 'trace' ? 'active-tab' : ''} onClick={() => setView('trace')}><Terminal size={14} /> Trace</button></nav>
      <div className="scenario-select"><GitBranch size={14} /><select aria-label="Scenario" value={scenario} onChange={e => chooseScenario(e.target.value)}>{SCENARIOS.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select></div>
      <div className="playback"><span className={`run-state ${running ? 'green' : 'muted'}`}><i className={running ? 'live-dot' : 'paused-dot'} />{running ? 'Running' : 'Paused'}</span><time className="sim-time" data-testid="sim-time">{(engine.now / 1000).toFixed(2)} s</time>
        <div className="playback-buttons"><button className="icon-button" title={running ? 'Pause simulation' : 'Resume simulation'} aria-label={running ? 'Pause simulation' : 'Resume simulation'} onClick={() => setRunning(!running)}>{running ? <Pause size={15} /> : <Play size={15} />}</button>
          <button className="icon-button" title="Step one 20 ms iteration" aria-label="Step 20 milliseconds" onClick={() => { setRunning(false); advance(1); }}><SkipForward size={15} /></button>
          <button className="icon-button" title="Reset current configuration" aria-label="Reset simulation" onClick={() => apply(engine.config)}><RotateCcw size={14} /></button></div>
        <select aria-label="Simulation speed" className="speed-select" value={speed} onChange={e => setSpeed(Number(e.target.value))}>{[0.25, 0.5, 1, 2, 4].map(s => <option key={s} value={s}>{s}x</option>)}</select>
      </div>
    </div>
    <div className="workspace">
      <Controls key={generation} config={engine.config} input={input} setInput={setInput} add={add} notice={notice} apply={apply}
        feature={key => { engine.setFeatures({ [key]: !engine.config[key] }); refresh(); }}
        traffic={traffic} setTraffic={setTraffic} rate={rate} setRate={setRate} />
      <main>
        <MetricsStrip engine={engine} />
        <div className="runtime-heading"><div><Activity size={15} /><h2>{view === 'runtime' ? 'Runtime overview' : 'Execution trace'}</h2><span className="subtle">iteration {engine.now / 20}</span></div><span className="subtle mono">{engine.config.continuousBatching ? 'CONTINUOUS' : 'STATIC'} / FCFS</span></div>
        <div className="pipeline">
          <div><i className="dot waiting" /><span>Queued</span><b>{m.waiting}</b></div><ArrowRight size={13} />
          <div><i className="dot prefill" /><span>Prefill</span><b>{engine.requests.filter(r => r.status === 'prefill').length}</b></div><ArrowRight size={13} />
          <div><i className="dot decode" /><span>Decode</span><b>{engine.requests.filter(r => r.status === 'decode').length}</b></div><ArrowRight size={13} />
          <div><i className="dot completed" /><span>Completed</span><b>{m.completed}</b></div>
          <span className="pipeline-rejected">{m.rejected} rejected / {m.cancelled} cancelled</span>
        </div>
        {view === 'runtime' ? <>
          <div className="runtime-grid"><div className="left-column"><Workers engine={engine} select={setSelected} /><Queue engine={engine} selected={selected} select={setSelected} cancel={id => { engine.cancel(id); refresh(); }} /></div>
            <Cache engine={engine} selected={selected} select={setSelected} /></div>
          <div className="bottom-grid"><Timeline engine={engine} select={setSelected} /><Inspector request={selectedRequest} /></div>
          <div className="bottom-grid"><SchedulerLog engine={engine} /><Telemetry engine={engine} /></div>
        </> : <div className="trace-view"><Timeline engine={engine} select={setSelected} /><div className="bottom-grid"><SchedulerLog engine={engine} /><Inspector request={selectedRequest} /></div><Telemetry engine={engine} /></div>}
        <footer className="statusbar"><span><i className="live-dot" /> ENGINE CONNECTED</span><span>20 ms step</span><span>Seed 73</span><span>In-memory / no model weights</span><span className="statusbar-right">vLLM-inspired execution model</span></footer>
      </main>
    </div>
  </div>;
}
