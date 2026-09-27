// Deterministic workload generator.
//
// Arrival processes: constant rate (credit accumulator), Poisson (exponential
// inter-arrivals from the seeded RNG) and periodic bursts, plus full trace
// replay (fixed request list with scheduled arrival times).
//
// Length distributions: fixed / uniform / weighted-discrete over prompt and
// output tokens, with a configurable probability of reusing the shared prefix
// family and a priority-class mix. Everything runs off the engine's seeded RNG,
// so identical seeds reproduce identical workloads in browser and CLI.

import { poissonDelayMs, weightedPick, type Rng } from './rng.ts';
import type { ArrivalMode, Priority, RequestInput } from './types.ts';
import { finiteInt } from './types.ts';

export type Distribution =
  | { kind: 'fixed'; value: number }
  | { kind: 'uniform'; min: number; max: number }
  | { kind: 'discrete'; options: { value: number; weight: number }[] };

export interface TraceRequest {
  atMs: number;
  input: RequestInput;
  /** Real-trace reference observations — carried through to the request for display only. */
  observed?: { ttftMs?: number; tpotMs?: number; e2eMs?: number };
}

export interface TrafficSpec {
  enabled: boolean;
  arrival: ArrivalMode;
  rate: number;                          // req/s (constant & poisson)
  burstSize: number;                     // requests per burst
  burstEveryMs: number;                  // burst period
  prompt: Distribution;
  output: Distribution;
  prefix: string;                        // shared prefix family
  prefixReuseProbability: number;        // probability a request uses the family vs a unique prompt
  priorityMix: { low: number; normal: number; high: number };
  sloTTFTms?: number;                    // optional per-request SLO override
  sloTPOTms?: number;
  requests?: TraceRequest[];             // trace replay mode
}

export const defaultTraffic = (rate = 2): TrafficSpec => ({
  enabled: true,
  arrival: 'constant',
  rate,
  burstSize: 4,
  burstEveryMs: 4000,
  prompt: { kind: 'fixed', value: 256 },
  output: { kind: 'fixed', value: 64 },
  prefix: 'chat',
  prefixReuseProbability: 1,
  priorityMix: { low: 0, normal: 1, high: 0 },
});

const sampleDist = (d: Distribution, rng: Rng, min: number, max: number): number => {
  let v: number;
  if (d.kind === 'fixed') v = d.value;
  else if (d.kind === 'uniform') v = d.min + rng() * (d.max - d.min);
  else {
    const total = d.options.reduce((n, o) => n + Math.max(0, o.weight), 0);
    let roll = rng() * total;
    v = d.options[0].value;
    for (const o of d.options) { roll -= Math.max(0, o.weight); if (roll <= 0) { v = o.value; break; } }
  }
  return finiteInt(v, min, max);
};

export class WorkloadGenerator {
  private spec: TrafficSpec;
  private rng: Rng;
  private credit = 0;
  private nextAt: number;
  private traceIndex = 0;

  constructor(spec: TrafficSpec, rng: Rng, now = 0) {
    this.spec = spec;
    this.rng = rng;
    this.nextAt = spec.arrival === 'poisson' ? now + poissonDelayMs(rng, spec.rate)
      : spec.arrival === 'burst' ? now + spec.burstEveryMs
      : now;
  }

  get current(): TrafficSpec { return this.spec; }

  /** Remaining scripted trace arrivals (trace mode only). */
  get pending(): number {
    if (this.spec.arrival !== 'trace') return 0;
    return Math.max(0, (this.spec.requests?.length ?? 0) - this.traceIndex);
  }

  update(patch: Partial<TrafficSpec>) {
    this.spec = { ...this.spec, ...patch };
  }

  sample(): RequestInput {
    const s = this.spec;
    const usesPrefix = this.rng() < s.prefixReuseProbability;
    const priority: Priority = weightedPick(this.rng, [
      { value: 'low' as Priority, weight: s.priorityMix.low },
      { value: 'normal' as Priority, weight: s.priorityMix.normal },
      { value: 'high' as Priority, weight: s.priorityMix.high },
    ]);
    const input: RequestInput = {
      promptTokens: sampleDist(s.prompt, this.rng, 1, 8192),
      outputTokens: sampleDist(s.output, this.rng, 1, 1024),
      prefix: usesPrefix ? s.prefix : 'none',
      priority,
    };
    if (s.sloTTFTms !== undefined) input.sloTTFTms = s.sloTTFTms;
    if (s.sloTPOTms !== undefined) input.sloTPOTms = s.sloTPOTms;
    return input;
  }

  /** Advance to `now`; return the inputs that arrive at this instant. */
  tick(now: number, dtMs: number): RequestInput[] {
    if (!this.spec.enabled) return [];
    const out: RequestInput[] = [];
    if (this.spec.arrival === 'trace') {
      const requests = this.spec.requests ?? [];
      while (this.traceIndex < requests.length && requests[this.traceIndex].atMs <= now) {
        const t = requests[this.traceIndex];
        out.push({ ...t.input, ...(t.observed ? { observed: t.observed } : {}) });
        this.traceIndex++;
      }
      return out;
    }
    if (this.spec.arrival === 'poisson') {
      while (this.nextAt <= now) {
        out.push(this.sample());
        this.nextAt += poissonDelayMs(this.rng, this.spec.rate);
      }
      return out;
    }
    if (this.spec.arrival === 'burst') {
      while (this.nextAt <= now) {
        for (let i = 0; i < Math.max(1, Math.round(this.spec.burstSize)); i++) out.push(this.sample());
        this.nextAt += Math.max(1, this.spec.burstEveryMs);
      }
      return out;
    }
    // constant: credit accumulator (deterministic fractional arrivals)
    this.credit += this.spec.rate * dtMs / 1000;
    while (this.credit >= 1) {
      this.credit -= 1;
      out.push(this.sample());
    }
    return out;
  }
}
