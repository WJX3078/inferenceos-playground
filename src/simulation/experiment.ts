// Experiment framework: versioned scenario files, schema validation, headless
// runs, parameter sweeps, multi-seed statistics and deterministic replay.
//
// A scenario file pins engine version, seed, config and workload; running it
// always produces identical metrics and the same fingerprint (same engine
// version, seed and workload).

import { SimulationEngine } from './engine.ts';
import { ENGINE_VERSION } from './version.ts';
import { hashHex } from './rng.ts';
import type { Metrics } from './types.ts';
import type { ArrivalMode } from './types.ts';
import type { Distribution } from './workload.ts';
import type { TrafficSpec, TraceRequest } from './workload.ts';

export { ENGINE_VERSION };
export const SCENARIO_SCHEMA_VERSION = 1;

export interface ScenarioFile {
  version: number;
  name?: string;
  seed?: number;
  seeds?: number[];                        // multi-seed mode (see runMultiSeed)
  config?: Record<string, unknown>;        // Partial<Config> (validated below)
  traffic?: Partial<TrafficSpec>;          // workload; requests[] = trace replay
  maxSimMs?: number;                       // safety cap (default 120000)
  sweep?: SweepSpec[];
  notes?: string;
}

export interface SweepSpec { path: string; values: (number | string | boolean)[] }
/** e.g. "seed" | "config.maxNumBatchedTokens" | "traffic.rate" | "traffic.prompt.value" */

export interface Fingerprint {
  engineVersion: number;
  scenarioSchemaVersion: number;
  seed: number;
  configHash: string;
  workloadHash: string;
  resultHash: string;
  gitCommit?: string;
}

export interface RunResult {
  scenario: string;
  engineVersion: number;
  seed: number;
  simulatedMs: number;
  iterations: number;
  drained: boolean;
  fingerprint: Fingerprint;
  config: Record<string, unknown>;
  summary: Metrics;
  counters: {
    completed: number; rejected: number; cancelled: number;
    outputTokens: number; preemptions: number; recomputedTokens: number;
    evictions: number; drafted: number; accepted: number;
    transfersCompleted: number; networkBytes: number;
    gpuHitBlocks: number; cpuHitBlocks: number; remoteHitBlocks: number; recomputeBlocks: number;
    starvationEvents: number; backpressureEvents: number;
  };
  observations?: unknown[];
}

// ---------- deterministic JSON hashing ----------

/** JSON.stringify with recursively sorted object keys — stable across runs. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(v => stableStringify(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export function hashOf(value: unknown): string {
  const s = stableStringify(value);
  // FNV-1a over the low byte of each UTF-16 code unit.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    h = Math.imul(h ^ (code & 0xff), 0x01000193);
    h = Math.imul(h ^ ((code >>> 8) & 0xff), 0x01000193);
  }
  return hashHex(h >>> 0);
}

// ---------- schema validation ----------

const KNOWN_CONFIG_KEYS = new Set([
  'gpuCount', 'tensorParallel', 'blockSize', 'numBlocks',
  'maxBatchSize', 'continuousBatching', 'schedulerPolicy', 'maxNumBatchedTokens',
  'prefillChunkSize', 'decodePriority', 'preemptionMode', 'preemptionCooldownMs',
  'starvationThresholdMs', 'kvWatermark', 'prefixCaching', 'speculativeDecoding',
  'specDraftLength', 'specAcceptance', 'specCost', 'numLayers', 'numKVHeads',
  'headDim', 'bytesPerElement', 'servingMode', 'prefillGpuCount', 'prefillTP',
  'decodeGpuCount', 'decodeTP', 'kvTransferBandwidthGBps', 'kvTransferLatencyUs',
  'maxConcurrentTransfers', 'transferSchedulingPolicy', 'maxPendingDecodeRequests',
  'kvTiers', 'cpuKvBlocks', 'cpuRestoreBandwidthGBps', 'cpuRestoreLatencyMs',
  'remoteKvBlocks', 'remoteRestoreBandwidthGBps', 'remoteRestoreLatencyMs',
  'sloTTFTms', 'sloTPOTms',
]);

const CONFIG_RANGES: Record<string, { min: number; max: number; integer?: boolean }> = {
  gpuCount: { min: 1, max: 8 }, tensorParallel: { min: 1, max: 8 },
  blockSize: { min: 4, max: 128 }, numBlocks: { min: 8, max: 8192 },
  maxBatchSize: { min: 1, max: 64 }, maxNumBatchedTokens: { min: 8, max: 65536 },
  prefillChunkSize: { min: 0, max: 8192 }, kvWatermark: { min: 0, max: 0.5 },
  preemptionCooldownMs: { min: 0, max: 60000 }, starvationThresholdMs: { min: 0, max: 600000 },
  specDraftLength: { min: 1, max: 16 }, specCost: { min: 1, max: 4 },
  numLayers: { min: 1, max: 128 }, numKVHeads: { min: 1, max: 128 },
  headDim: { min: 32, max: 512 }, bytesPerElement: { min: 1, max: 4 },
  kvTransferBandwidthGBps: { min: 1, max: 400 }, kvTransferLatencyUs: { min: 0, max: 100000 },
  maxConcurrentTransfers: { min: 1, max: 64 }, maxPendingDecodeRequests: { min: 0, max: 256 },
  cpuKvBlocks: { min: 0, max: 65536 }, remoteKvBlocks: { min: 0, max: 65536 },
  cpuRestoreBandwidthGBps: { min: 1, max: 400 }, remoteRestoreBandwidthGBps: { min: 1, max: 400 },
  cpuRestoreLatencyMs: { min: 0, max: 1000 }, remoteRestoreLatencyMs: { min: 0, max: 1000 },
  sloTTFTms: { min: 20, max: 60000 }, sloTPOTms: { min: 5, max: 60000 },
  prefillGpuCount: { min: 1, max: 8 }, decodeGpuCount: { min: 1, max: 8 },
  prefillTP: { min: 1, max: 8 }, decodeTP: { min: 1, max: 8 },
};

function validateDistribution(d: unknown, where: string, problems: string[]) {
  if (typeof d !== 'object' || d === null) { problems.push(`${where} must be an object`); return; }
  const o = d as Record<string, unknown>;
  if (o.kind === 'fixed') {
    if (!Number.isFinite(o.value) || (o.value as number) < 1) problems.push(`${where}.value must be a positive number`);
  } else if (o.kind === 'uniform') {
    if (!Number.isFinite(o.min) || !Number.isFinite(o.max) || (o.min as number) > (o.max as number)) {
      problems.push(`${where}.min/max must be numbers with min <= max`);
    }
  } else if (o.kind === 'discrete') {
    if (!Array.isArray(o.options) || !o.options.length) problems.push(`${where}.options must be a non-empty array`);
  } else {
    problems.push(`${where}.kind must be "fixed" | "uniform" | "discrete"`);
  }
}

/**
 * Runtime schema validation with precise error messages. runScenario throws
 * on any problem instead of silently falling back.
 */
export function validateScenario(file: ScenarioFile): string[] {
  const problems: string[] = [];
  if (file.version !== SCENARIO_SCHEMA_VERSION) {
    problems.push(`version must be ${SCENARIO_SCHEMA_VERSION}, got ${String(file.version)}`);
  }
  if (file.seed !== undefined && (!Number.isInteger(file.seed) || file.seed < 0)) {
    problems.push(`seed must be a non-negative integer, got ${String(file.seed)}`);
  }
  if (file.seeds !== undefined && (!Array.isArray(file.seeds) || !file.seeds.length
    || !file.seeds.every(s => Number.isInteger(s) && s >= 0))) {
    problems.push('seeds must be a non-empty array of non-negative integers');
  }
  if (file.maxSimMs !== undefined && (!Number.isFinite(file.maxSimMs) || (file.maxSimMs as number) <= 0)) {
    problems.push('maxSimMs must be a positive number');
  }
  const config = file.config ?? {};
  for (const [k, v] of Object.entries(config)) {
    if (!KNOWN_CONFIG_KEYS.has(k)) { problems.push(`config.${k} is not a known engine setting`); continue; }
    const range = CONFIG_RANGES[k];
    if (range) {
      if (typeof v !== 'number' || !Number.isFinite(v)) { problems.push(`config.${k} must be a number, got ${String(v)}`); continue; }
      if (v < range.min || v > range.max) problems.push(`config.${k} must be within [${range.min}, ${range.max}], got ${String(v)}`);
    }
    if (k === 'schedulerPolicy' && !['fcfs', 'sjf', 'priority', 'slo'].includes(v as string)) {
      problems.push(`config.schedulerPolicy must be fcfs | sjf | priority | slo, got ${String(v)}`);
    }
    if (k === 'preemptionMode' && !['none', 'prefill-only', 'cost-aware', 'recompute'].includes(v as string)) {
      problems.push(`config.preemptionMode must be none | prefill-only | cost-aware, got ${String(v)}`);
    }
    if (k === 'servingMode' && !['monolithic', 'disaggregated'].includes(v as string)) {
      problems.push(`config.servingMode must be monolithic | disaggregated, got ${String(v)}`);
    }
    if (k === 'kvTiers' && !['gpu', 'gpu-cpu', 'gpu-cpu-remote'].includes(v as string)) {
      problems.push(`config.kvTiers must be gpu | gpu-cpu | gpu-cpu-remote, got ${String(v)}`);
    }
    if (k === 'transferSchedulingPolicy' && !['fair-share', 'fifo', 'priority'].includes(v as string)) {
      problems.push(`config.transferSchedulingPolicy must be fair-share | fifo | priority, got ${String(v)}`);
    }
  }
  const traffic = file.traffic ?? {};
  if (traffic.arrival !== undefined
    && !['constant', 'poisson', 'burst', 'trace'].includes(traffic.arrival as ArrivalMode)) {
    problems.push(`traffic.arrival must be constant | poisson | burst | trace, got ${String(traffic.arrival)}`);
  }
  if (traffic.rate !== undefined && (!Number.isFinite(traffic.rate) || (traffic.rate as number) <= 0)) {
    problems.push('traffic.rate must be a positive number');
  }
  if (traffic.prompt !== undefined) validateDistribution(traffic.prompt, 'traffic.prompt', problems);
  if (traffic.output !== undefined) validateDistribution(traffic.output, 'traffic.output', problems);
  if (traffic.requests !== undefined) {
    if (!Array.isArray(traffic.requests)) problems.push('traffic.requests must be an array');
    else {
      traffic.requests.forEach((r, i) => {
        if (typeof r !== 'object' || r === null || !Number.isFinite((r as TraceRequest).atMs)
          || typeof (r as TraceRequest).input?.promptTokens !== 'number') {
          problems.push(`traffic.requests[${i}] must be { atMs, input }`);
        }
      });
    }
  }
  if (file.sweep !== undefined) {
    if (!Array.isArray(file.sweep)) problems.push('sweep must be an array');
    else file.sweep.forEach((s, i) => {
      if (typeof s?.path !== 'string' || !/^(seed|config|traffic)(\.[A-Za-z]\w*)+$/.test(s.path)) {
        problems.push(`sweep[${i}].path must look like "config.maxNumBatchedTokens" or "seed"`);
      }
      if (!Array.isArray(s.values) || !s.values.length) problems.push(`sweep[${i}].values must be a non-empty array`);
    });
  }
  return problems;
}

// ---------- scenario instantiation & runs ----------

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
  const problems = validateScenario(file);
  if (problems.length) throw new Error(`Invalid scenario:\n${problems.map(p => `  - ${p}`).join('\n')}`);
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
  const result: RunResult = {
    scenario: file.name ?? 'unnamed',
    engineVersion: ENGINE_VERSION,
    seed,
    simulatedMs: engine.now,
    iterations: engine.iterations,
    drained,
    fingerprint: {
      engineVersion: ENGINE_VERSION,
      scenarioSchemaVersion: SCENARIO_SCHEMA_VERSION,
      seed,
      configHash: hashOf(engine.config),
      workloadHash: hashOf(engine.workload?.current ?? null),
      resultHash: '', // filled below
    },
    config: engine.config as unknown as Record<string, unknown>,
    summary: m,
    counters: {
      completed: m.completed, rejected: m.rejected, cancelled: m.cancelled,
      outputTokens: m.outputTokens,
      preemptions: m.preemptions, recomputedTokens: m.recomputedTokens,
      evictions: m.evictions, drafted: m.drafted, accepted: m.accepted,
      transfersCompleted: m.transfersCompleted, networkBytes: m.networkBytes,
      gpuHitBlocks: m.gpuHitBlocks, cpuHitBlocks: m.cpuHitBlocks,
      remoteHitBlocks: m.remoteHitBlocks, recomputeBlocks: m.recomputeBlocks,
      starvationEvents: m.starvationEvents, backpressureEvents: m.backpressureEvents,
    },
    observations: options?.includeObservations ? engine.collector.observations : undefined,
  };
  // The result hash covers everything a replay should reproduce.
  result.fingerprint.resultHash = hashOf({
    ms: result.simulatedMs, summary: result.summary, counters: result.counters,
  });
  return result;
}

// ---------- sweeps & multi-seed statistics ----------

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

export const DEFAULT_SEEDS = [1, 2, 3, 4, 5];
const AGGREGATED_KEYS = [
  'ttftP50', 'ttftP99', 'tpotP50', 'tpotP99', 'e2eP99',
  'tokensPerSecond', 'requestsPerSecond', 'goodput', 'sloAttainment',
  'preemptions', 'recomputedTokens', 'evictions',
] as const;

export type AggregatedKey = (typeof AGGREGATED_KEYS)[number];

export interface SeedAggregate {
  key: AggregatedKey;
  mean: number; median: number; min: number; max: number; stddev: number;
}

export function stats(values: number[]): { mean: number; median: number; min: number; max: number; stddev: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n; // population
  return {
    mean, median: sorted[Math.floor(n / 2)], min: sorted[0], max: sorted[n - 1],
    stddev: Math.sqrt(variance),
  };
}

export interface MultiSeedResult {
  scenario: string;
  seeds: number[];
  perSeed: RunResult[];
  aggregate: SeedAggregate[];
  /** Same seed list for every variant: comparisons are paired per seed. */
  paired: true;
}

/**
 * Multi-seed mode. Single-seed runs exist for byte-identical reproducibility;
 * multi-seed runs quantify how sensitive a configuration is to the stochastic
 * workload stream. Every variant uses the SAME seed list, so comparisons are
 * paired (per-seed deltas are meaningful).
 */
export function runMultiSeed(file: ScenarioFile, seeds: number[] = file.seeds ?? DEFAULT_SEEDS,
  options?: { includeObservations?: boolean }): MultiSeedResult {
  if (!seeds.length) throw new Error('runMultiSeed requires at least one seed');
  const perSeed = seeds.map(seed => runScenario(file, { ...options, overrides: { seed } }));
  const aggregate = AGGREGATED_KEYS.map(key => {
    const values = perSeed.map(r => r.summary[key] as number);
    return { key, ...stats(values) };
  });
  return { scenario: file.name ?? 'unnamed', seeds, perSeed, aggregate, paired: true };
}

/** Per-seed paired delta between two variants over the same seed list. */
export function runPairedComparison(base: ScenarioFile, variant: ScenarioFile,
  seeds: number[] = base.seeds ?? DEFAULT_SEEDS): {
    seeds: number[]; rows: { key: AggregatedKey; baseMean: number; variantMean: number; deltaMean: number }[];
  } {
  const a = runMultiSeed(base, seeds);
  const b = runMultiSeed(variant, seeds);
  return {
    seeds,
    rows: a.aggregate.map(({ key }) => {
      const av = a.perSeed.map(r => r.summary[key] as number);
      const bv = b.perSeed.map(r => r.summary[key] as number);
      const am = av.reduce((x, y) => x + y, 0) / av.length;
      const bm = bv.reduce((x, y) => x + y, 0) / bv.length;
      return { key, baseMean: am, variantMean: bm, deltaMean: bm - am };
    }),
  };
}

export function replayIdentical(a: RunResult, b: RunResult): boolean {
  const pick = (r: RunResult) => ({ s: r.summary, c: r.counters, ms: r.simulatedMs, f: r.fingerprint });
  return JSON.stringify(pick(a)) === JSON.stringify(pick(b));
}

export type { ArrivalMode, Distribution };
