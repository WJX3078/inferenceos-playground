import { useState } from 'react';
import { Check, ChevronDown, Cpu, Info, Plus, Radio, RotateCcw, SlidersHorizontal, Waves, Zap } from 'lucide-react';
import type { Config, RequestInput } from '../simulation/types';
import { normalizeConfig } from '../simulation/types';

export function Tip({ text }: { text: string }) {
  return <span className="tip" tabIndex={0} data-tip={text} aria-label={text}><Info size={12} /></span>;
}
export function Toggle({ label, value, onChange, tip }: { label: string; value: boolean; onChange: () => void; tip: string }) {
  return <div className="toggle-row"><span>{label} <Tip text={tip} /></span>
    <button type="button" className={`toggle ${value ? 'on' : ''}`} aria-label={label} aria-pressed={value} onClick={onChange}><span /></button>
  </div>;
}
export function NumberField({ label, value, min, max, onChange, unit }: {
  label: string; value: number; min: number; max: number; onChange: (n: number) => void; unit?: string;
}) {
  return <label className="field"><span>{label}</span><div className="input-unit">
    <input aria-label={label} type="number" min={min} max={max} required value={value} onChange={e => onChange(Number(e.target.value))} />
    {unit && <small>{unit}</small>}
  </div></label>;
}
export function SelectField({ label, value, options, onChange }: {
  label: string; value: number; options: number[]; onChange: (n: number) => void;
}) {
  return <label className="field"><span>{label}</span><div className="select-wrap">
    <select aria-label={label} value={value} onChange={e => onChange(Number(e.target.value))}>
      {options.map(n => <option key={n} value={n}>{n}</option>)}
    </select><ChevronDown size={12} />
  </div></label>;
}

interface Props {
  expert: boolean;
  config: Config; input: RequestInput; setInput: (r: RequestInput) => void;
  add: (count: number) => void; notice: string; apply: (c: Config) => void;
  feature: (key: 'continuousBatching' | 'prefixCaching' | 'speculativeDecoding') => void;
  traffic: boolean; setTraffic: (b: boolean) => void; rate: number; setRate: (n: number) => void;
}
export function Controls(p: Props) {
  const [hardware, setHardware] = useState(p.config);
  const [burst, setBurst] = useState(8);
  const dirty = ['gpuCount', 'tensorParallel', 'blockSize', 'numBlocks', 'maxBatchSize', 'maxNumBatchedTokens', 'maxPrefillTokensPerStep', 'schedulerPolicy', 'preemption', 'interconnect', 'bandwidthGBps', 'latencyUs'].some(k =>
    hardware[k as keyof Config] !== p.config[k as keyof Config]);
  const patch = (key: keyof Config, n: number) => setHardware(c => {
    const next = { ...c, [key]: n, ...(key === 'maxBatchSize' ? { maxNumSeqs: n } : {}) };
    return key === 'gpuCount' ? normalizeConfig(next) : next;
  });
  return <aside className="controls">
    <div className="sidebar-label"><SlidersHorizontal size={14} /><span>CONTROL PLANE</span><span className="version">01</span></div>
    <section className="control-section">
      <h2><Plus size={15} /> Request generator</h2>
      <form onSubmit={e => { e.preventDefault(); p.add(1); }}>
        <NumberField label="Prompt length" value={p.input.promptTokens} min={1} max={8192} unit="tokens" onChange={n => p.setInput({ ...p.input, promptTokens: n })} />
        <NumberField label="Output length" value={p.input.outputTokens} min={1} max={1024} unit="tokens" onChange={n => p.setInput({ ...p.input, outputTokens: n })} />
        <label className="field"><span>Shared prefix <Tip text="A prefix family represents identical token content. Up to 128 prompt tokens are shared, rounded to complete KV blocks." /></span>
          <select aria-label="Shared prefix" value={p.input.prefix} onChange={e => p.setInput({ ...p.input, prefix: e.target.value })}>
            <option value="none">Unique prompt</option><option value="chat">Chat / system prompt</option><option value="code">Code / repository</option><option value="docs">Docs / context</option>
          </select>
        </label>
        {p.expert && <label className="field"><span>Request priority</span><select aria-label="Request priority" value={p.input.priority ?? 'NORMAL'} onChange={e => p.setInput({ ...p.input, priority: e.target.value as RequestInput['priority'] })}>{['LOW', 'NORMAL', 'HIGH'].map(priority => <option key={priority}>{priority}</option>)}</select></label>}
        <button className="primary full" type="submit"><Plus size={15} /> Add request</button>
      </form>
      <div className="burst-row"><input aria-label="Burst size" type="number" value={burst} min={1} max={64} onChange={e => setBurst(Number(e.target.value))} />
        <button className="secondary" aria-label="Generate burst" onClick={() => p.add(burst)}><Zap size={14} /> Burst</button>
      </div>
      <div className="arrival-notice" data-testid="arrival-notice" role="status"><Check size={11} /> {p.notice || 'Generator ready'}</div>
      <Toggle label="Stream traffic" value={p.traffic} onChange={() => p.setTraffic(!p.traffic)} tip="Adds requests at a fixed rate in simulation time, with seeded length variation. Pausing freezes arrivals too." />
      <label className="range-field"><span>Arrival rate <b>{p.rate} req/s</b></span>
        <input aria-label="Arrival rate" type="range" min={0.5} max={8} step={0.5} value={p.rate} onChange={e => p.setRate(Number(e.target.value))} />
      </label>
    </section>
    <section className="control-section">
      <h2><Waves size={15} /> Scheduling</h2>
      <Toggle label="Continuous batching" value={p.config.continuousBatching} onChange={() => p.feature('continuousBatching')} tip="On: admit new requests into freed slots each iteration. Off: a replica's entire cohort must drain before another cohort starts." />
      <Toggle label="Prefix caching" value={p.config.prefixCaching} onChange={() => p.feature('prefixCaching')} tip="Reuse immutable full KV pages for identical prefix tokens in the same replica. Unreferenced pages are evicted LRU." />
      <Toggle label="Speculative decoding" value={p.config.speculativeDecoding} onChange={() => p.feature('speculativeDecoding')} tip="Draft up to four tokens, verify an accepted prefix, then commit a correction or bonus token. Verification costs 1.65 decode iterations." />
    </section>
    {p.expert && <section className="control-section hardware">
      <h2><Cpu size={15} /> Hardware & memory</h2>
      <div className="two-fields">
        <SelectField label="GPU count" value={hardware.gpuCount} options={[1, 2, 4, 8]} onChange={n => patch('gpuCount', n)} />
        <SelectField label="Tensor parallel degree" value={hardware.tensorParallel} options={[1, 2, 4, 8].filter(n => hardware.gpuCount % n === 0)} onChange={n => patch('tensorParallel', n)} />
      </div>
      <div className="two-fields">
        <SelectField label="KV block size" value={hardware.blockSize} options={[8, 16, 32, 64]} onChange={n => patch('blockSize', n)} />
        <NumberField label="Max batch size" value={hardware.maxBatchSize} min={1} max={16} onChange={n => patch('maxBatchSize', n)} />
      </div>
      <NumberField label="KV blocks / replica" value={hardware.numBlocks} min={16} max={512} unit="blocks" onChange={n => patch('numBlocks', n)} />
      <NumberField label="Token budget" value={hardware.maxNumBatchedTokens} min={1} max={8192} unit="tokens" onChange={n => patch('maxNumBatchedTokens', n)} />
      <NumberField label="Prefill chunk limit" value={hardware.maxPrefillTokensPerStep} min={1} max={8192} unit="tokens" onChange={n => patch('maxPrefillTokensPerStep', n)} />
      <label className="field"><span>Scheduler policy</span><select aria-label="Scheduler policy" value={hardware.schedulerPolicy} onChange={e => setHardware(h => ({ ...h, schedulerPolicy: e.target.value as Config['schedulerPolicy'] }))}><option value="fcfs">FCFS</option><option value="priority">Priority + aging</option></select></label>
      <Toggle label="Recompute preemption" value={hardware.preemption} onChange={() => setHardware(h => ({ ...h, preemption: !h.preemption }))} tip="Under priority policy, release a lower-priority sequence only when the incoming request can then fit. Rebuild its context before emitting more output." />
      <label className="field"><span>Interconnect</span><select aria-label="Interconnect" value={hardware.interconnect} onChange={e => setHardware(h => ({ ...h, interconnect: e.target.value as Config['interconnect'] }))}><option value="nvlink">NVLink (illustrative)</option><option value="pcie">PCIe (illustrative)</option><option value="custom">Custom</option></select></label>
      {hardware.interconnect === 'custom' && <><NumberField label="Bandwidth" value={hardware.bandwidthGBps} min={0.1} max={1000} unit="GB/s" onChange={n => patch('bandwidthGBps', n)} /><NumberField label="Link latency" value={hardware.latencyUs} min={0} max={10000} unit="µs" onChange={n => patch('latencyUs', n)} /></>}
      <div className="capacity"><span>Context capacity</span><b>{(hardware.numBlocks * hardware.blockSize).toLocaleString()} tok / replica</b></div>
      <button className={`secondary full ${dirty ? 'dirty' : ''}`} disabled={!dirty} onClick={() => p.apply(normalizeConfig({ ...hardware, continuousBatching: p.config.continuousBatching, prefixCaching: p.config.prefixCaching, speculativeDecoding: p.config.speculativeDecoding }))}>
        <RotateCcw size={13} /> Apply & restart
      </button>
    </section>}
    <div className="sidebar-footer"><Radio size={13} /><span>Local simulation</span><span className="live-dot" /></div>
  </aside>;
}
