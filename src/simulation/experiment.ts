// Experiment framework: versioned scenario files, headless runs, parameter
// sweeps and deterministic replay.
//
// A scenario file pins engine version, seed, config and workload; running it
// always produces identical metrics (same engine version, seed and workload).

import { SimulationEngine } from './engine.ts';
import type { Metrics } from './types.ts';
import type { TrafficSpec, TraceRequest } from './workload.ts';

export const ENGINE_VERSION = 2;

export interface ScenarioFile {
  version: 1;
  name?: string;
  seed?: number;
  config?: Record<string, unknown>;        // Partial<Config> (validated by normalizeConfig)
  traffic?: Partial<TrafficSpec>;          // workload; requests[] = trace replay
  maxSimMs?: number;                       // safety cap (default 120000)
  sweep?: SweepSpec[];
  notes?: string;
}

export interface SweepSpec { path: string; values: (number | string | boolean)[] }
/** e.g. "seed" | "config.maxNumBatchedTokens" | "traffic.rate" | "traffic.prompt.value" */

export interface RunResult {
  scenario: string;
  engineVersion: number;
  seed: number;
  simulatedMs: number;
  iterations: number;
  drained: boolean;
  config: Record<string, unknown>;
  summary: Metrics;
  counters: {
    completed: number; rejected: number; cancelled: number;
    outputTokens: number; preemptions: number; recomputedTokens: number;
    evictions: number; drafted: number; accepted: number;
    transfersCompleted: number; networkBytes: number;
    tierHitsGpu: number; tierHitsCpu: number; tierHitsRemote: number; tierRecomputes: number;
  };
  observations?: unknown[];
}

export function mergeDeep<T extends Record<string, unknown>>(base: T, patch?: Partial<T>): T {
  if (!patch) return { ...base };
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const b = out[k];
    out[k] = typeof v === 'object' && v !== null && !Array.isArray(v)
      && typeof b === 'object' && b !== null && !Array.isArray(b)
      ? mergeDeep(b as Record<string, unknown>, v as Record<string, unknown>)
      : v;
  }
  return out as T;
}

export function instantiateScenario(file: ScenarioFile, overrides?: Record<string, unknown>): {
  engine: SimulationEngine; seed: number;
} {
  if (file.version !== 1) throw new Error(`Unsupported scenario version: ${file.version}`);
  const config = mergeDeep(file.config ?? {}, overrides?.config as Record<string, unknown>);
  const traffic = mergeDeep(file.traffic ?? {}, overrides?.traffic as Record<string, unknown>);
  const seed = Number(overrides?.seed ?? file.seed ?? 73);
  const engine = new SimulationEngine(config as never, seed);
  const trace = traffic.requests as TraceRequest[] | undefined;
  if (Array.isArray(trace) && trace.length) {
    engine.setTraffic({ ...traffic, enabled: true, arrival: 'trace', requests: trace } as Partial<TrafficSpec>);
  } else if (traffic.enabled !== false) {
    engine.setTraffic({
      ...traffic,
      enabled: true,
      arrival: traffic.arrival ?? 'constant',
      rate: traffic.rate ?? 2,
      prefix: traffic.prefix ?? 'none',
      prompt: traffic.prompt ?? { kind: 'fixed', value: 256 },
      output: traffic.output ?? { kind: 'fixed', value: 64 },
    } as Partial<TrafficSpec>);
  }
  return { engine, seed };
}

const MAX_TICKS_PER_STEP = 10000;

export function runScenario(file: ScenarioFile, options?: {
  overrides?: Record<string, unknown>;
  includeObservations?: boolean;
}): RunResult {
  const { engine, seed } = instantiateScenario(file, options?.overrides);
  const maxSimMs = file.maxSimMs ?? 120000;
  const traceRequests = (file.traffic?.requests ?? []) as TraceRequest[];
  const isTrace = Array.isArray(traceRequests) && traceRequests.length > 0;
  const lastArrival = isTrace ? Math.max(...traceRequests.map(r => r.atMs)) : 0;
  while (engine.now < maxSimMs) {
    const pending = engine.requests.some(r =>
      r.status !== 'completed' && r.status !== 'rejected' && r.status !== 'cancelled');
    // Trace workloads end when the last arrival drained; streaming workloads
    // run to the cap (arrivals never stop by design).
    if (isTrace && !pending && engine.now >= lastArrival) break;
    engine.step(Math.min(MAX_TICKS_PER_STEP, Math.ceil((maxSimMs - engine.now) / 20)));
  }
  const m = engine.metrics;
  const drained = !engine.requests.some(r =>
    r.status === 'waiting' || r.status === 'prefill' || r.status === 'decode' ||
    r.status === 'preempted' || r.status === 'transfer_wait' || r.status === 'transferring' ||
    r.status === 'decode_wait');
  return {
    scenario: file.name ?? 'unnamed',
    engineVersion: ENGINE_VERSION,
    seed,
    simulatedMs: engine.now,
    iterations: engine.iterations,
    drained,
    config: engine.config as unknown as Record<string, unknown>,
    summary: m,
    counters: {
      completed: m.completed, rejected: m.rejected, cancelled: m.cancelled,
      outputTokens: m.outputTokens,
      preemptions: m.preemptions, recomputedTokens: m.recomputedTokens,
      evictions: m.evictions, drafted: m.drafted, accepted: m.accepted,
      transfersCompleted: m.transfersCompleted, networkBytes: m.networkBytes,
      tierHitsGpu: m.tierHitsGpu, tierHitsCpu: m.tierHitsCpu,
      tierHitsRemote: m.tierHitsRemote, tierRecomputes: m.tierRecomputes,
    },
    observations: options?.includeObservations ? engine.collector.observations : undefined,
  };
}

/** Cartesian product of sweep specs; every combination runs the base scenario. */
export function runSweep(file: ScenarioFile, options?: { includeObservations?: boolean }): RunResult[] {
  const sweeps = file.sweep ?? [];
  if (!sweeps.length) return [runScenario(file, options)];
  let combos: Record<string, unknown>[] = [{}];
  for (const spec of sweeps) {
    const next: Record<string, unknown>[] = [];
    for (const combo of combos) {
      for (const value of spec.values) {
        const clone: Record<string, unknown> = JSON.parse(JSON.stringify(combo));
        const parts = spec.path.split('.');
        let node = clone;
        for (let i = 0; i < parts.length - 1; i++) {
          const child = node[parts[i]];
          node[parts[i]] = typeof child === 'object' && child !== null ? { ...child } : {};
          node = node[parts[i]] as Record<string, unknown>;
        }
        node[parts[parts.length - 1]] = value;
        next.push(clone);
      }
    }
    combos = next;
  }
  return combos.map(overrides => runScenario(file, { ...options, overrides }));
}

export function replayIdentical(a: RunResult, b: RunResult): boolean {
  const pick = (r: RunResult) => ({ s: r.summary, c: r.counters, ms: r.simulatedMs });
  return JSON.stringify(pick(a)) === JSON.stringify(pick(b));
}
