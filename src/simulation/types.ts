export type Phase = 'waiting' | 'prefill' | 'decode' | 'completed' | 'cancelled' | 'rejected' | 'preempted' | 'recompute';
export type Priority = 'LOW' | 'NORMAL' | 'HIGH';
export interface Config {
  gpuCount: number;
  tensorParallel: number;
  blockSize: number;
  numBlocks: number;
  maxBatchSize: number;
  maxNumSeqs: number;
  maxNumBatchedTokens: number;
  maxPrefillTokensPerStep: number;
  schedulerPolicy: 'fcfs' | 'priority';
  preemption: boolean;
  interconnect: 'pcie' | 'nvlink' | 'custom';
  bandwidthGBps: number;
  latencyUs: number;
  continuousBatching: boolean;
  prefixCaching: boolean;
  speculativeDecoding: boolean;
}
export interface RequestInput { promptTokens: number; outputTokens: number; prefix: string; priority?: Priority; tokenIds?: readonly number[] }
export interface PrefixBlock {
  index: number; hash: string; parentHash: string; start: number; end: number;
}
export interface PrefixLookup extends PrefixBlock { hit: boolean; page: number | null }
export interface Span { phase: Phase; start: number; end: number; tokens?: number; iteration?: number }
export interface Request extends RequestInput {
  id: string;
  tokenIds: readonly number[];
  prefixChain: readonly PrefixBlock[];
  prefixLookup: PrefixLookup[];
  priority: Priority;
  waitingSince: number;
  queueMs: number;
  preemptions: number;
  recomputing: boolean;
  recomputeUntil: number;
  recomputeLostUntil: number;
  recomputedTokens: number;
  resumedAt: number;
  preemptedAt?: number;
  status: Phase;
  arrivedAt: number;
  admittedAt?: number;
  firstTokenAt?: number;
  lastTokenAt?: number;
  finishedAt?: number;
  group: number | null;
  processed: number;
  generated: number;
  cachedTokens: number;
  prefixTokens: number;
  blockTable: number[];
  compute: number;
  reason: string;
  spans: Span[];
  speculative: { drafted: number; accepted: number; rejected: number } | null;
}
export interface KVBlock {
  id: number;
  owners: string[];
  key: string | null;
  used: number;
  lastUsed: number;
  generation: number;
  identity: readonly number[] | null;
  logicalIndex: number | null;
}
export interface Worker {
  id: number; group: number; rank: number; requestIds: string[];
  utilization: number; phase: 'idle' | 'prefill' | 'decode' | 'mixed';
}
export interface SchedulerEvent { id: number; at: number; type: string; requestId?: string; message: string }
export interface Allocation { requestId: string; phase: 'prefill' | 'decode'; tokens: number; priority: string }
export interface Iteration {
  iteration: number; group: number; at: number; budget: number; used: number;
  decodeTokens: number; prefillTokens: number; remaining: number;
  scheduled: Allocation[]; skipped: { requestId: string; reason: string; priority: string }[];
  pinned: number; reserved: number; capacity: number; slots: number; maxSlots: number;
  cost?: BatchCost;
}
export interface TPStage { name: string; kind: 'compute' | 'communication'; ms: number }
export interface BatchCost { computeMs: number; communicationMs: number; collectiveBytes: number; totalMs: number; stages: TPStage[] }
export interface TPStats { computeMs: number; communicationMs: number; collectiveBytes: number }
export interface SchedulerStats { iterations: number; prefillTokens: number; decodeTokens: number; mixedIterations: number; usedTokens: number; availableTokens: number }
export interface Metrics {
  ttft: number | null; tpot: number | null; tokensPerSecond: number; requestsPerSecond: number;
  kvUtilization: number; prefixHitRate: number; gpuUtilization: number;
  active: number; waiting: number; completed: number; rejected: number; cancelled: number;
  outputTokens: number; cachedTokens: number; evictions: number; drafted: number; accepted: number;
}
export interface Sample { at: number; tokens: number; gpu: number; kv: number }
export const DEFAULT_CONFIG: Config = {
  gpuCount: 2, tensorParallel: 1, blockSize: 16, numBlocks: 128,
  maxBatchSize: 4, continuousBatching: true, prefixCaching: true, speculativeDecoding: false,
  maxNumSeqs: 4, maxNumBatchedTokens: 2048, maxPrefillTokensPerStep: 32, schedulerPolicy: 'fcfs',
  preemption: false,
  interconnect: 'nvlink', bandwidthGBps: 300, latencyUs: 5,
};
export const STEP_MS = 20;
export const active = (r: Request) => r.status === 'prefill' || r.status === 'decode';
export const finiteInt = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(Number.isFinite(n) ? n : min)));
export function normalizeConfig(partial: Partial<Config>): Config {
  const c = { ...DEFAULT_CONFIG, ...partial };
  c.gpuCount = [1, 2, 4, 8].includes(c.gpuCount) ? c.gpuCount : 2;
  c.tensorParallel = [1, 2, 4, 8].filter(x => x <= c.tensorParallel && c.gpuCount % x === 0).at(-1) ?? 1;
  c.blockSize = [8, 16, 32, 64].includes(c.blockSize) ? c.blockSize : 16;
  c.numBlocks = finiteInt(c.numBlocks, 16, 512);
  c.maxNumSeqs = finiteInt(partial.maxNumSeqs ?? partial.maxBatchSize ?? DEFAULT_CONFIG.maxNumSeqs, 1, 16);
  c.maxBatchSize = c.maxNumSeqs;
  c.maxNumBatchedTokens = finiteInt(c.maxNumBatchedTokens, 1, 8192);
  c.maxPrefillTokensPerStep = finiteInt(c.maxPrefillTokensPerStep, 1, 8192);
  c.schedulerPolicy = c.schedulerPolicy === 'priority' ? 'priority' : 'fcfs';
  c.interconnect = ['nvlink', 'pcie', 'custom'].includes(c.interconnect) ? c.interconnect : 'nvlink';
  c.bandwidthGBps = Math.max(0.1, Math.min(1000, Number.isFinite(c.bandwidthGBps) ? c.bandwidthGBps : 1));
  c.latencyUs = finiteInt(c.latencyUs, 0, 10000);
  return c;
}
