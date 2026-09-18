import { SimulationEngine } from './engine';
import { active, finiteInt, STEP_MS } from './types';
import type { Config, Metrics } from './types';
import type { WorkloadTrace } from './workload';
import { freezeTrace } from './workload';

export interface Strategy { id: string; name: string; color: string; config: Partial<Config> }
export const STRATEGIES: readonly Strategy[] = [
  { id: 'static', name: 'Static', color: '#e4b666', config: { continuousBatching: false, prefixCaching: false, speculativeDecoding: false } },
  { id: 'continuous', name: 'Continuous', color: '#73b5f5', config: { continuousBatching: true, prefixCaching: false, speculativeDecoding: false } },
  { id: 'prefix', name: '+ Prefix', color: '#d39be3', config: { continuousBatching: true, prefixCaching: true, speculativeDecoding: false } },
  { id: 'spec', name: '+ Spec', color: '#66d7b0', config: { continuousBatching: true, prefixCaching: true, speculativeDecoding: true } },
];
export const PRIORITY_STRATEGIES: readonly Strategy[] = [
  { id: 'fcfs', name: 'FCFS', color: '#e4b666', config: { schedulerPolicy: 'fcfs', preemption: false } },
  { id: 'priority', name: 'Priority + aging', color: '#73b5f5', config: { schedulerPolicy: 'priority', preemption: true } },
];
export function tpStrategies(): Strategy[] {
  return [1, 2, 4, 8].map((tp, i) => ({
    id: `tp${tp}`, name: `TP${tp}`, color: STRATEGIES[i].color,
    config: { gpuCount: tp, tensorParallel: tp, continuousBatching: true, prefixCaching: true, speculativeDecoding: false },
  }));
}
export interface ComparisonMetrics extends Metrics { queueTime: number; duration: number }
export interface ComparisonSample { at: number; queue: number; tokens: number; gpu: number; kv: number; active: number }
export class Experiment {
  readonly engine: SimulationEngine;
  cursor = 0;
  finishedAt: number | null = null;
  samples: ComparisonSample[] = [];
  readonly received: { id: string; arrival: number; promptTokens: number; outputTokens: number; prefix: string; priority: string; tokenIds: readonly number[] }[] = [];
  constructor(readonly strategy: Strategy, readonly trace: WorkloadTrace, config: Partial<Config>, readonly seed: number) {
    this.engine = new SimulationEngine({ numBlocks: 512, ...config, ...strategy.config }, seed);
  }
  step() {
    if (this.finishedAt !== null) return;
    while (this.cursor < this.trace.length && this.trace[this.cursor].arrival <= this.engine.now) {
      const input = this.trace[this.cursor++];
      const r = this.engine.enqueue(input);
      this.received.push({ id: r.id, arrival: r.arrivedAt, promptTokens: r.promptTokens, outputTokens: r.outputTokens, prefix: r.prefix, priority: r.priority, tokenIds: r.tokenIds });
    }
    this.engine.step();
    if (this.cursor === this.trace.length && !this.engine.requests.some(r => active(r) || r.status === 'waiting')) this.finishedAt = this.engine.now;
  }
  sample(at: number) {
    const m = this.engine.metrics;
    const idle = this.finishedAt !== null && at > this.finishedAt;
    this.samples.push({ at, queue: m.waiting, tokens: idle ? 0 : m.tokensPerSecond, gpu: idle ? 0 : m.gpuUtilization, kv: m.kvUtilization, active: m.active });
  }
  get metrics(): ComparisonMetrics {
    const m = this.engine.metrics, duration = this.finishedAt ?? this.engine.now;
    const seconds = Math.max(STEP_MS, duration) / 1000;
    return {
      ...m, duration, tokensPerSecond: m.outputTokens / seconds, requestsPerSecond: m.completed / seconds,
      gpuUtilization: duration ? this.engine.occupancyIntegral.gpu / duration : 0,
      kvUtilization: duration ? this.engine.occupancyIntegral.kv / duration : 0,
      queueTime: this.engine.collector.admissions ? this.engine.collector.queueMs / this.engine.collector.admissions : 0,
    };
  }
}
export class Comparison {
  readonly experiments: Experiment[];
  readonly trace: WorkloadTrace;
  now = 0;
  timedOut = false;
  constructor(trace: WorkloadTrace, config: Partial<Config> = {}, readonly seed = 73, strategies: readonly Strategy[] = STRATEGIES) {
    this.trace = freezeTrace(trace);
    if (!strategies.length || new Set(strategies.map(s => s.id)).size !== strategies.length) throw new Error('Strategies require unique IDs');
    this.experiments = strategies.map(s => new Experiment(s, this.trace, config, seed));
    this.experiments.forEach(e => e.sample(0));
  }
  get done() { return this.timedOut || this.experiments.every(e => e.finishedAt !== null); }
  step(count = 1) {
    for (let i = 0; i < finiteInt(count, 1, 10000) && !this.done; i++) {
      this.experiments.forEach(e => e.step());
      this.now += STEP_MS;
      this.timedOut = this.now >= 120000 && this.experiments.some(e => e.finishedAt === null);
      if (this.now % 100 === 0 || this.done) this.experiments.forEach(e => e.sample(this.now));
    }
  }
  assertInvariants() {
    for (const e of this.experiments) {
      if (e.trace !== this.trace || e.seed !== this.seed) throw new Error('Experiment workload diverged');
      e.received.forEach((r, i) => {
        const t = this.trace[i];
        if (r.id !== t.id || r.arrival !== t.arrival || r.promptTokens !== t.promptTokens || r.outputTokens !== t.outputTokens || r.prefix !== t.prefix || r.priority !== (t.priority ?? 'NORMAL')
          || r.tokenIds.length !== t.tokenIds!.length || r.tokenIds.some((token, j) => token !== t.tokenIds![j])) throw new Error('Replay diverged');
      });
      e.engine.assertInvariants();
      for (const value of Object.values(e.metrics)) if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new Error('Invalid comparison metric');
    }
  }
}
export function delta(value: number | null, baseline: number | null): number | null {
  return value === null || baseline === null || baseline === 0 ? null : (value - baseline) / baseline * 100;
}
