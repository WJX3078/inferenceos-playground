import { finiteInt, STEP_MS } from './types';
import type { RequestInput } from './types';
import { tokenIdentity } from './cache';

export type ArrivalPattern = 'uniform' | 'burst' | 'poisson' | 'prefix-heavy' | 'long-context' | 'mixed';
export type Distribution = 'fixed' | 'uniform' | 'bimodal';
export interface WorkloadConfig {
  seed: number; count: number; pattern: ArrivalPattern; intervalMs: number;
  promptMin: number; promptMax: number; outputMin: number; outputMax: number;
  promptDistribution: Distribution; outputDistribution: Distribution;
  prefixReuse: number; longContextRatio: number; burstiness: number;
}
export interface TraceEntry extends Readonly<RequestInput> { readonly id: string; readonly arrival: number }
export type WorkloadTrace = readonly TraceEntry[];
/** Validate once, then own an immutable replay snapshot, including token identity. */
export function freezeTrace(trace: WorkloadTrace): WorkloadTrace {
  if (!trace.length || trace.length > 256) throw new Error('Trace requires 1–256 requests');
  trace.forEach((r, i) => {
    if (r.id !== `R${String(i + 1).padStart(3, '0')}`
      || !Number.isSafeInteger(r.arrival) || r.arrival < 0 || r.arrival % STEP_MS || (i && r.arrival < trace[i - 1].arrival)
      || !Number.isInteger(r.promptTokens) || r.promptTokens < 1 || r.promptTokens > 8192
      || !Number.isInteger(r.outputTokens) || r.outputTokens < 1 || r.outputTokens > 1024
      || !['chat', 'code', 'docs', 'none'].includes(r.prefix)
      || (r.priority !== undefined && !['LOW', 'NORMAL', 'HIGH'].includes(r.priority))
      || (r.tokenIds && (r.tokenIds.length !== r.promptTokens || r.tokenIds.some(t => !Number.isSafeInteger(t))))) {
      throw new Error('Invalid trace: sequential IDs, sorted 20 ms arrivals and valid token identities required');
    }
  });
  if (Object.isFrozen(trace) && trace.every(r => Object.isFrozen(r) && r.tokenIds && Object.isFrozen(r.tokenIds))) return trace;
  return Object.freeze(trace.map((r, i) => Object.freeze({
    ...r, tokenIds: tokenIdentity(r.promptTokens, r.prefix, i + 1, r.tokenIds),
  })));
}
export const DEFAULT_WORKLOAD: WorkloadConfig = {
  seed: 73, count: 40, pattern: 'mixed', intervalMs: 100,
  promptMin: 128, promptMax: 768, outputMin: 16, outputMax: 96,
  promptDistribution: 'uniform', outputDistribution: 'bimodal',
  prefixReuse: 0.7, longContextRatio: 0.1, burstiness: 0.7,
};
export function buildWorkload(partial: Partial<WorkloadConfig> = {}): WorkloadTrace {
  const c = { ...DEFAULT_WORKLOAD, ...partial };
  let seed = finiteInt(c.seed, 0, 0xffffffff) >>> 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const ratio = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
  const length = (min: number, max: number, distribution: Distribution, cap: number) => {
    const lo = finiteInt(min, 1, cap), hi = finiteInt(max, lo, cap);
    if (distribution === 'fixed') return lo;
    if (distribution === 'bimodal') return random() < 0.7 ? lo : hi;
    return Math.floor(lo + random() * (hi - lo + 1));
  };
  const interval = finiteInt(c.intervalMs, 0, 2000);
  let arrival = 0;
  return Object.freeze(Array.from({ length: finiteInt(c.count, 1, 256) }, (_, i) => {
    if (i) {
      const burst = c.pattern === 'burst' || c.pattern === 'mixed';
      const gap = c.pattern === 'poisson' ? -Math.log(Math.max(1e-9, 1 - random())) * interval
        : burst ? (random() < ratio(c.burstiness) ? 0 : interval / Math.max(0.1, 1 - ratio(c.burstiness))) : interval;
      arrival += Math.round(gap / STEP_MS) * STEP_MS;
    }
    const prompt = length(c.promptMin, c.promptMax, c.promptDistribution, 8192);
    const long = random() < (c.pattern === 'long-context' ? Math.max(0.7, ratio(c.longContextRatio)) : ratio(c.longContextRatio));
    const reuse = c.pattern === 'prefix-heavy' ? Math.max(0.9, ratio(c.prefixReuse)) : ratio(c.prefixReuse);
    const prefix = random() < reuse ? ['chat', 'code', 'docs'][Math.floor(random() * 3)] : 'none';
    const promptTokens = Math.min(8192, long ? Math.max(2048, prompt * 4) : prompt);
    return Object.freeze({
      id: `R${String(i + 1).padStart(3, '0')}`, arrival,
      promptTokens, tokenIds: tokenIdentity(promptTokens, prefix, i + 1),
      outputTokens: length(c.outputMin, c.outputMax, c.outputDistribution, 1024), prefix,
      priority: (i % 7 === 0 ? 'HIGH' : i % 3 === 0 ? 'LOW' : 'NORMAL') as 'HIGH' | 'LOW' | 'NORMAL',
    });
  }));
}

/** A display checksum, not a cryptographic identity or a fairness assertion. */
export function fingerprint(trace: WorkloadTrace): string {
  let hash = 2166136261;
  for (const char of JSON.stringify(trace)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
