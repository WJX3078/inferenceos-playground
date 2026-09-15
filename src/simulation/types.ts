export type Phase = 'waiting' | 'prefill' | 'decode' | 'completed' | 'cancelled' | 'rejected';
export interface Config {
  gpuCount: number;
  tensorParallel: number;
  blockSize: number;
  numBlocks: number;
  maxBatchSize: number;
  continuousBatching: boolean;
  prefixCaching: boolean;
  speculativeDecoding: boolean;
}
export interface RequestInput { promptTokens: number; outputTokens: number; prefix: string }
export interface Span { phase: Phase; start: number; end: number }
export interface Request extends RequestInput {
  id: string;
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
}
export interface Worker {
  id: number; group: number; rank: number; requestIds: string[];
  utilization: number; phase: 'idle' | 'prefill' | 'decode' | 'mixed';
}
export interface SchedulerEvent { id: number; at: number; type: string; requestId?: string; message: string }
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
  c.maxBatchSize = finiteInt(c.maxBatchSize, 1, 16);
  return c;
}
