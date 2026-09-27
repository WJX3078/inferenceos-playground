import { useState } from 'react';
import { Check, ChevronDown, Cpu, Info, Network, Plus, Radio, RotateCcw, SlidersHorizontal, Waves, Zap } from 'lucide-react';
import type { Config, Priority, RequestInput, SchedulerPolicy } from '../simulation/types';
import { normalizeConfig } from '../simulation/types';

export function Tip({ text }: { text: string }) {
  return <span className="tip" tabIndex={0} data-tip={text} aria-label={text}><Info size={12} /></span>;
}
export function Toggle({ label, value, onChange, tip }: { label: string; value: boolean; onChange: () => void; tip: string }) {
  return <div className="toggle-row"><span>{label} <Tip text={tip} /></span>
    <button type="button" className={`toggle ${value ? 'on' : ''}`} aria-label={label} aria-pressed={value} onClick={onChange}><span /></button>
  </div>;
}
export function NumberField({ label, value, min, max, onChange, unit, step = 1 }: {
  label: string; value: number; min: number; max: number; onChange: (n: number) => void; unit?: string; step?: number;
}) {
  return <label className="field"><span>{label}</span><div className="input-unit">
    <input aria-label={label} type="number" min={min} max={max} step={step} required value={value} onChange={e => onChange(Number(e.target.value))} />
    {unit && <small>{unit}</small>}
  </div></label>;
}
export function TextField({ label, value, options, onChange, tip }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; tip?: string;
}) {
  return <label className="field"><span>{label} {tip && <Tip text={tip} />}</span><div className="select-wrap">
    <select aria-label={label} value={value} onChange={e => onChange(e.target.value)}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select><ChevronDown size={12} />
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
  config: Config; input: RequestInput; setInput: (r: RequestInput) => void;
  add: (count: number) => void; notice: string; apply: (c: Config) => void;
  setFeature: <K extends keyof Config>(key: K, value: Config[K]) => void;
  traffic: boolean; setTraffic: (b: boolean) => void; rate: number; setRate: (n: number) => void;
  onExportScenario: () => void; onImportScenario: (file: File) => void;
}
export function Controls(p: Props) {
  const [hardware, setHardware] = useState(p.config);
  const [burst, setBurst] = useState(8);
  const dirty = (['gpuCount', 'tensorParallel', 'blockSize', 'numBlocks', 'servingMode',
    'prefillGpuCount', 'prefillTP', 'decodeTP', 'kvTiers', 'cpuKvBlocks', 'remoteKvBlocks',
    'cpuRestoreBandwidthGBps', 'cpuRestoreLatencyMs', 'remoteRestoreBandwidthGBps', 'remoteRestoreLatencyMs',
    'kvTransferLatencyUs'] as const).some(k => hardware[k] !== p.config[k]);
  const patch = (key: keyof Config, n: number) => setHardware(c => {
    const next = { ...c, [key]: n };
    return normalizeConfig(key === 'gpuCount' || key === 'prefillGpuCount' || key === 'servingMode' ? next : next);
  });
  const disagg = hardware.servingMode === 'disaggregated';
  return <aside className="controls">
    <div className="sidebar-label"><SlidersHorizontal size={14} /><span>CONTROL PLANE</span><span className="version">02</span></div>
    <section className="control-section">
      <h2><Plus size={15} /> Request generator</h2>
      <form onSubmit={e => { e.preventDefault(); p.add(1); }}>
        <div className="two-fields">
          <NumberField label="Prompt length" value={p.input.promptTokens} min={1} max={8192} unit="tokens" onChange={n => p.setInput({ ...p.input, promptTokens: n })} />
          <NumberField label="Output length" value={p.input.outputTokens} min={1} max={1024} unit="tokens" onChange={n => p.setInput({ ...p.input, outputTokens: n })} />
        </div>
        <div className="two-fields">
          <TextField label="Shared prefix" value={p.input.prefix} onChange={v => p.setInput({ ...p.input, prefix: v })}
            tip="A prefix family stands for identical token content. Up to 128 prompt tokens are shareable, rounded to complete KV blocks. Cache identity is a content hash over synthetic tokens."
            options={[{ value: 'none', label: 'Unique prompt' }, { value: 'chat', label: 'Chat / system' }, { value: 'code', label: 'Code / repo' }, { value: 'docs', label: 'Docs / context' }]} />
          <TextField label="Priority" value={p.input.priority ?? 'normal'} onChange={v => p.setInput({ ...p.input, priority: v as Priority })}
            tip="Priority class used by the Priority scheduler (high > normal > low) and by preemption decisions."
            options={[{ value: 'low', label: 'Low' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }]} />
        </div>
        <button className="primary full" type="submit"><Plus size={15} /> Add request</button>
      </form>
      <div className="burst-row"><input aria-label="Burst size" type="number" value={burst} min={1} max={64} onChange={e => setBurst(Number(e.target.value))} />
        <button className="secondary" aria-label="Generate burst" onClick={() => p.add(burst)}><Zap size={14} /> Burst</button>
      </div>
      <div className="arrival-notice" data-testid="arrival-notice" role="status"><Check size={11} /> {p.notice || 'Generator ready'}</div>
      <Toggle label="Stream traffic" value={p.traffic} onChange={() => p.setTraffic(!p.traffic)} tip="Adds requests at the configured rate in simulation time with a deterministic seeded workload generator. Pausing freezes arrivals too." />
      <label className="range-field"><span>Arrival rate <b>{p.rate} req/s</b></span>
        <input aria-label="Arrival rate" type="range" min={0.5} max={8} step={0.5} value={p.rate} onChange={e => p.setRate(Number(e.target.value))} />
      </label>
    </section>
    <section className="control-section">
      <h2><Waves size={15} /> Scheduling</h2>
      <TextField label="Scheduler policy" value={p.config.schedulerPolicy} onChange={v => p.setFeature('schedulerPolicy', v as SchedulerPolicy)}
        options={[
          { value: 'fcfs', label: 'FCFS' },
          { value: 'sjf', label: 'SJF / shortest remaining' },
          { value: 'priority', label: 'Priority' },
          { value: 'slo', label: 'SLO-aware' },
        ]}
        tip="FCFS: arrival order. SJF: least remaining work. Priority: class order. SLO-aware: urgency = estimated time-to-first-token / slack until the TTFT deadline." />
      <div className="two-fields">
        <NumberField label="Token budget / iter" value={p.config.maxNumBatchedTokens} min={8} max={8192} unit="tok" onChange={n => p.setFeature('maxNumBatchedTokens', n)} />
        <SelectField label="Prefill chunk" value={p.config.prefillChunkSize} options={[0, 16, 32, 64, 128, 256, 512, 1024]} onChange={n => p.setFeature('prefillChunkSize', n)} />
      </div>
      <div className="two-fields">
        <NumberField label="Max batch size" value={p.config.maxBatchSize} min={1} max={16} onChange={n => p.setFeature('maxBatchSize', n)} />
        <NumberField label="KV watermark" value={p.config.kvWatermark} min={0} max={0.5} step={0.05} onChange={n => p.setFeature('kvWatermark', n)} />
      </div>
      <Toggle label="Continuous batching" value={p.config.continuousBatching} onChange={() => p.setFeature('continuousBatching', !p.config.continuousBatching)} tip="On: admit new requests into freed slots each iteration. Off: a replica's whole cohort must drain first (static batching)." />
      <Toggle label="Decode priority" value={p.config.decodePriority} onChange={() => p.setFeature('decodePriority', !p.config.decodePriority)} tip="On: decoding sequences claim the token budget before prefill chunks. Off: prefill goes first and long prefills can stall decodes (ITL spikes)." />
      <Toggle label="Prefix caching" value={p.config.prefixCaching} onChange={() => p.setFeature('prefixCaching', !p.config.prefixCaching)} tip="Reuse immutable full KV blocks for identical prefix token content on the same replica. Unreferenced blocks are evicted LRU." />
      <TextField label="Preemption" value={p.config.preemptionMode} onChange={v => p.setFeature('preemptionMode', v as Config['preemptionMode'])}
        tip="Cost-aware: a strictly higher-ranked waiting request may evict the CHEAPEST running victim (fewest tokens to recompute), gated by a cooldown and a minimum residency. Prefill-only never evicts decoding requests."
        options={[{ value: 'none', label: 'None' }, { value: 'prefill-only', label: 'Prefill-only' }, { value: 'cost-aware', label: 'Cost-aware' }]} />
      <NumberField label="Preemption cooldown" value={p.config.preemptionCooldownMs} min={0} max={60000} unit="ms" onChange={n => p.setFeature('preemptionCooldownMs', n)} />
      <NumberField label="Starvation threshold" value={p.config.starvationThresholdMs} min={0} max={600000} unit="ms" onChange={n => p.setFeature('starvationThresholdMs', n)} />
    </section>
    <section className="control-section">
      <h2><Waves size={15} /> SLO & goodput</h2>
      <div className="two-fields">
        <NumberField label="TTFT SLO" value={p.config.sloTTFTms} min={20} max={10000} unit="ms" onChange={n => p.setFeature('sloTTFTms', n)} />
        <NumberField label="TPOT SLO" value={p.config.sloTPOTms} min={5} max={10000} unit="ms" onChange={n => p.setFeature('sloTPOTms', n)} />
      </div>
      <div className="capacity"><span>Only completions meeting both targets count into goodput and SLO attainment.</span></div>
    </section>
    <section className="control-section">
      <h2><Zap size={15} /> Speculative decoding</h2>
      <Toggle label="Speculative decoding" value={p.config.speculativeDecoding} onChange={() => p.setFeature('speculativeDecoding', !p.config.speculativeDecoding)} tip="Draft several tokens per verify step, accept the matching prefix, discard the rest, commit a correction. The step costs specCost times an ordinary decode step." />
      {p.config.speculativeDecoding && <>
        <div className="two-fields">
          <SelectField label="Draft length" value={p.config.specDraftLength} options={[1, 2, 4, 8, 16]} onChange={n => p.setFeature('specDraftLength', n)} />
          <TextField label="Acceptance" value={p.config.specAcceptance} onChange={v => p.setFeature('specAcceptance', v as Config['specAcceptance'])}
            options={[{ value: 'low', label: 'Low (25%)' }, { value: 'medium', label: 'Medium (70%)' }, { value: 'high', label: 'High (92%)' }]} />
        </div>
        <NumberField label="Step cost multiplier" value={p.config.specCost} min={1} max={4} step={0.05} unit="x decode" onChange={n => p.setFeature('specCost', n)} />
      </>}
    </section>
    <section className="control-section hardware">
      <h2><Cpu size={15} /> Topology & memory <span className="restart-hint">restart</span></h2>
      <div className="two-fields">
        <SelectField label="GPU count" value={hardware.gpuCount} options={[1, 2, 4, 8]} onChange={n => patch('gpuCount', n)} />
        <SelectField label="Tensor parallel" value={hardware.tensorParallel} options={[1, 2, 4, 8].filter(n => hardware.gpuCount % n === 0 && !disagg)} onChange={n => patch('tensorParallel', n)} />
      </div>
      <TextField label="Serving topology" value={hardware.servingMode} onChange={v => setHardware(c => normalizeConfig({ ...c, servingMode: v as Config['servingMode'] }))}
        options={[{ value: 'monolithic', label: 'Monolithic (P+D together)' }, { value: 'disaggregated', label: 'Disaggregated (P/D pools)' }]}
        tip="Disaggregated: prefill and decode run on separate pools and KV is transferred between them over the modeled interconnect." />
      {disagg && <div className="two-fields">
        <SelectField label="Prefill GPUs" value={hardware.prefillGpuCount} options={Array.from({ length: hardware.gpuCount - 1 }, (_, i) => i + 1)} onChange={n => patch('prefillGpuCount', n)} />
        <div className="capacity"><span>Decode GPUs</span><b>{hardware.gpuCount - hardware.prefillGpuCount}</b></div>
      </div>}
      {disagg && <div className="two-fields">
        <SelectField label="Prefill TP" value={hardware.prefillTP} options={[1, 2, 4, 8].filter(n => hardware.prefillGpuCount % n === 0)} onChange={n => patch('prefillTP', n)} />
        <SelectField label="Decode TP" value={hardware.decodeTP} options={[1, 2, 4, 8].filter(n => (hardware.gpuCount - hardware.prefillGpuCount) % n === 0)} onChange={n => patch('decodeTP', n)} />
      </div>}
      <div className="two-fields">
        <SelectField label="KV block size" value={hardware.blockSize} options={[8, 16, 32, 64]} onChange={n => patch('blockSize', n)} />
        <NumberField label="KV blocks / replica" value={hardware.numBlocks} min={16} max={512} unit="blocks" onChange={n => patch('numBlocks', n)} />
      </div>
      <TextField label="KV tiers" value={hardware.kvTiers} onChange={v => setHardware(c => normalizeConfig({ ...c, kvTiers: v as Config['kvTiers'] }))}
        tip="Optional memory hierarchy for evicted prefix blocks: GPU only, GPU+CPU, or GPU+CPU+Remote. All restore latencies and bandwidths are illustrative, not measured hardware."
        options={[{ value: 'gpu', label: 'GPU only' }, { value: 'gpu-cpu', label: 'GPU + CPU' }, { value: 'gpu-cpu-remote', label: 'GPU + CPU + Remote' }]} />
      {hardware.kvTiers !== 'gpu' && <div className="two-fields">
        <NumberField label="CPU tier" value={hardware.cpuKvBlocks} min={0} max={8192} unit="blocks" onChange={n => patch('cpuKvBlocks', n)} />
        <NumberField label="Remote tier" value={hardware.remoteKvBlocks} min={0} max={65536} unit="blocks" onChange={n => patch('remoteKvBlocks', n)} />
      </div>}
      {disagg && <div className="two-fields">
        <NumberField label="KV transfer BW" value={hardware.kvTransferBandwidthGBps} min={1} max={400} unit="GB/s" onChange={n => patch('kvTransferBandwidthGBps', n)} />
        <NumberField label="Transfer latency" value={hardware.kvTransferLatencyUs} min={0} max={10000} unit="us" onChange={n => patch('kvTransferLatencyUs', n)} />
      </div>}
      {disagg && <>
        <TextField label="Transfer scheduling" value={p.config.transferSchedulingPolicy} onChange={v => p.setFeature('transferSchedulingPolicy', v as Config['transferSchedulingPolicy'])}
          tip="How concurrent KV transfers share the pipe: fair-share splits bandwidth equally, fifo serves the queue strictly head-of-line, priority starts high-priority requests first."
          options={[{ value: 'fair-share', label: 'Fair-share' }, { value: 'fifo', label: 'FIFO (serial)' }, { value: 'priority', label: 'Priority-first' }]} />
        <NumberField label="Backpressure limit" value={p.config.maxPendingDecodeRequests} min={0} max={256} unit="pending" onChange={n => p.setFeature('maxPendingDecodeRequests', n)} />
        <div className="capacity"><span>0 disables backpressure; otherwise prefill admission pauses when the decode pipeline holds this many pending requests.</span></div>
      </>}
      <div className="capacity"><span>Context capacity</span><b>{(hardware.numBlocks * hardware.blockSize).toLocaleString()} tok / replica</b></div>
      <button className={`secondary full ${dirty ? 'dirty' : ''}`} disabled={!dirty}
        onClick={() => {
          // Hardware restart keeps every live feature at its current value.
          const live: Record<string, unknown> = {};
          for (const k of ['schedulerPolicy', 'maxBatchSize', 'maxNumBatchedTokens', 'prefillChunkSize', 'decodePriority',
            'preemptionMode', 'kvWatermark', 'continuousBatching', 'prefixCaching', 'speculativeDecoding',
            'specDraftLength', 'specAcceptance', 'specCost', 'sloTTFTms', 'sloTPOTms',
            'kvTransferBandwidthGBps', 'maxConcurrentTransfers'] as const) {
            live[k] = p.config[k];
          }
          p.apply(normalizeConfig({ ...hardware, ...live } as Config));
        }}>
        <RotateCcw size={13} /> Apply & restart
      </button>
      <div className="export-row">
        <button type="button" className="secondary" onClick={p.onExportScenario}><Network size={13} /> Export scenario</button>
        <label className="secondary import-button"><Network size={13} /> Import
          <input type="file" accept="application/json,.jsonl" aria-label="Import scenario" onChange={e => { const f = e.target.files?.[0]; if (f) p.onImportScenario(f); e.target.value = ''; }} />
        </label>
      </div>
    </section>
    <div className="sidebar-footer"><Radio size={13} /><span>Local deterministic simulation</span><span className="live-dot" /></div>
  </aside>;
}
