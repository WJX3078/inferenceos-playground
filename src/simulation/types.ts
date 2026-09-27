// Core contracts for the InferenceOS Lab simulation core.
// The simulation is deterministic: same seed + config + workload + action
// ordering => identical results. No wall-clock time enters any decision.

export type Phase =
  | 'waiting'          // in the admission queue
  | 'prefill'          // prefill / recompute in progress
  | 'decode'           // autoregressive decode in progress
  | 'preempted'        // evicted while running; KV lost, waits to resume with recompute
  | 'transfer_wait'    // disaggregated: prefill done, KV transfer queued
  | 'transferring'     // disaggregated: KV transfer in flight
  | 'decode_wait'      // disaggregated: KV arrived on decode pool, waiting for decode admission
  | 'completed'
  | 'cancelled'
  | 'rejected';
export type Priority = 'low' | 'normal' | 'high';
export type SchedulerPolicy = 'fcfs' | 'sjf' | 'priority' | 'slo';
/** Legacy alias 'recompute' normalizes to 'cost-aware'. */
export type PreemptionMode = 'none' | 'prefill-only' | 'cost-aware' | 'recompute';
export type ServingMode = 'monolithic' | 'disaggregated';
export type AcceptanceProfile = 'low' | 'medium' | 'high';
export type KvTierMode = 'gpu' | 'gpu-cpu' | 'gpu-cpu-remote';
export type PoolKind = 'both' | 'prefill' | 'decode';
export type ArrivalMode = 'constant' | 'poisson' | 'burst' | 'trace';
export type TransferSchedulingPolicy = 'fair-share' | 'fifo' | 'priority';

export const PRIORITIES: Priority[] = ['low', 'normal', 'high'];
export const priorityRank = (p: Priority) => PRIORITIES.indexOf(p);

export interface Config {
  // Hardware & memory
  gpuCount: number;             // total GPUs in the cluster
  tensorParallel: number;       // TP degree (monolithic mode)
  blockSize: number;            // tokens per KV block
  numBlocks: number;            // KV blocks per replica pool
  // Batching & scheduling
  maxBatchSize: number;         // sequences per replica
  continuousBatching: boolean;  // false = static cohorts
  schedulerPolicy: SchedulerPolicy;
  maxNumBatchedTokens: number;  // token budget per scheduler iteration per replica
  prefillChunkSize: number;     // max prompt tokens per prefill sequence per iteration; 0 = off
  decodePriority: boolean;      // true: decode claims the token budget before prefill
  preemptionMode: PreemptionMode;
  preemptionCooldownMs: number; // min simulated ms between two preemptions (anti-storm)
  starvationThresholdMs: number; // waiting time before aging promotes a request; 0 = disabled
  kvWatermark: number;          // 0..0.5 fraction of the pool reserved away from admission
  // Prefix caching & speculative decoding
  prefixCaching: boolean;
  speculativeDecoding: boolean;
  specDraftLength: number;      // drafted tokens per verify step
  specAcceptance: AcceptanceProfile;
  specCost: number;             // decode step cost multiplier while speculating (illustrative)
  // KV size model: bytes/token = 2 * numLayers * numKVHeads * headDim * bytesPerElement
  numLayers: number;
  numKVHeads: number;
  headDim: number;
  bytesPerElement: number;
  // Topology
  servingMode: ServingMode;
  prefillGpuCount: number;
  prefillTP: number;
  decodeGpuCount: number;
  decodeTP: number;
  kvTransferBandwidthGBps: number;   // illustrative
  kvTransferLatencyUs: number;       // illustrative fixed latency
  maxConcurrentTransfers: number;
  transferSchedulingPolicy: TransferSchedulingPolicy;
  maxPendingDecodeRequests: number;  // P/D backpressure: pending decode-side requests before prefill admission pauses; 0 = off
  // Multi-tier KV (all latencies/bandwidths illustrative, never measured hardware)
  kvTiers: KvTierMode;
  cpuKvBlocks: number;
  cpuRestoreBandwidthGBps: number;
  cpuRestoreLatencyMs: number;
  remoteKvBlocks: number;
  remoteRestoreBandwidthGBps: number;
  remoteRestoreLatencyMs: number;
  // SLO
  sloTTFTms: number;
  sloTPOTms: number;
}

export interface RequestInput {
  promptTokens: number;
  outputTokens: number;
  prefix: string;
  priority?: Priority;
  sloTTFTms?: number;
  sloTPOTms?: number;
  /** Real-trace reference observations — display only, never drive the simulation. */
  observed?: { ttftMs?: number; tpotMs?: number; e2eMs?: number };
}

export interface Span { phase: Phase; start: number; end: number }

export interface Request extends RequestInput {
  id: string;
  status: Phase;
  arrivedAt: number;
  admittedAt?: number;          // most recent admission into a pool
  prefillAdmittedAt?: number;
  decodeAdmittedAt?: number;
  prefillDoneAt?: number;       // prefill (or recompute) finished
  firstTokenAt?: number;
  lastTokenAt?: number;
  finishedAt?: number;
  priority: Priority;
  sloTTFT: number;              // resolved at enqueue time (request override or global)
  sloTPOT: number;
  group: number | null;         // pool the request currently holds resources on
  prefillGroup: number | null;
  decodeGroup: number | null;
  processed: number;            // prefill/recompute progress toward contextTarget()
  generated: number;
  cachedTokens: number;         // prefix tokens reused at last admission
  prefixTokens: number;         // shareable prefix length (whole blocks)
  blockTable: number[];
  compute: number;              // decode-time accumulator (ms)
  reason: string;
  spans: Span[];
  preemptions: number;
  recomputedTokens: number;
  transfer: { id: number; bytes: number; queuedAt: number; startedAt?: number; finishedAt?: number } | null;
  pendingRestoreCount: number;  // outstanding tier-restore records before admission may proceed
  tierHit: 'gpu' | 'cpu' | 'remote' | null;
  resumeTarget: number | null;  // context tokens to recompute after a preemption resume
  starvedSince: number | null;  // sim time when aging first promoted this request
  observed: RequestInput['observed'];
  speculative: { drafted: number; accepted: number; rejected: number } | null;
  tokenSeed: number;            // per-request synthetic token stream seed
}

export interface KVBlock {
  id: number;
  owners: string[];
  key: string | null;           // content hash for immutable cached blocks
  used: number;
  lastUsed: number;
  generation: number;
}

export interface Worker {
  id: number;
  group: number;
  rank: number;
  kind: PoolKind;
  requestIds: string[];
  utilization: number;
  phase: 'idle' | 'prefill' | 'decode' | 'mixed';
}

export interface SchedulerEvent { id: number; at: number; type: string; requestId?: string; message: string }

export interface BudgetUsage { total: number; decode: number; prefill: number; unused: number }

export interface Metrics {
  ttft: number | null;
  tpot: number | null;
  ttftP50: number | null; ttftP90: number | null; ttftP95: number | null; ttftP99: number | null;
  tpotP50: number | null; tpotP90: number | null; tpotP95: number | null; tpotP99: number | null;
  e2eP50: number | null; e2eP95: number | null; e2eP99: number | null;
  tokensPerSecond: number;
  requestsPerSecond: number;
  goodput: number;              // SLO-meeting completions / s (rolling window)
  sloAttainment: number;        // % of completions meeting both SLOs
  ttftSloAttainment: number;
  tpotSloAttainment: number;
  kvUtilization: number;
  prefixHitRate: number;
  gpuUtilization: number;
  prefillUtilization: number;
  decodeUtilization: number;
  active: number;
  waiting: number;
  preempted: number;
  inTransfer: number;
  completed: number;
  rejected: number;
  cancelled: number;
  outputTokens: number;
  cachedTokens: number;
  evictions: number;
  preemptions: number;
  recomputedTokens: number;
  drafted: number;
  accepted: number;
  tokenBudgetUtilization: number;
  schedulerIterations: number;
  // disaggregated serving
  networkBytes: number;
  transfersActive: number;
  transfersQueued: number;
  transfersCompleted: number;
  // multi-tier KV (block-granular)
  gpuHitBlocks: number;
  cpuHitBlocks: number;
  remoteHitBlocks: number;
  recomputeBlocks: number;
  restoreBytes: number;
  restores: number;
  tierBytesMoved: number;
  // starvation protection & backpressure
  starvationEvents: number;
  maxQueueWait: number | null;
  backpressureEvents: number;
  backpressureTicks: number;
  // transfer pipeline
  transferWaitP50: number | null;
  transferWaitP99: number | null;
  networkUtilization: number;
}

export interface Sample { at: number; tokens: number; gpu: number; kv: number }

export const DEFAULT_CONFIG: Config = {
  gpuCount: 2,
  tensorParallel: 1,
  blockSize: 16,
  numBlocks: 128,
  maxBatchSize: 4,
  continuousBatching: true,
  schedulerPolicy: 'fcfs',
  maxNumBatchedTokens: 32,
  prefillChunkSize: 0,
  decodePriority: true,
  preemptionMode: 'none',
  preemptionCooldownMs: 500,
  starvationThresholdMs: 10000,
  kvWatermark: 0,
  prefixCaching: true,
  speculativeDecoding: false,
  specDraftLength: 4,
  specAcceptance: 'medium',
  specCost: 1.65,
  numLayers: 32,
  numKVHeads: 8,
  headDim: 128,
  bytesPerElement: 2,
  servingMode: 'monolithic',
  prefillGpuCount: 1,
  prefillTP: 1,
  decodeGpuCount: 1,
  decodeTP: 1,
  kvTransferBandwidthGBps: 32,
  kvTransferLatencyUs: 50,
  maxConcurrentTransfers: 4,
  transferSchedulingPolicy: 'fair-share',
  maxPendingDecodeRequests: 24,
  kvTiers: 'gpu',
  cpuKvBlocks: 512,
  cpuRestoreBandwidthGBps: 16,
  cpuRestoreLatencyMs: 2,
  remoteKvBlocks: 4096,
  remoteRestoreBandwidthGBps: 4,
  remoteRestoreLatencyMs: 20,
  sloTTFTms: 500,
  sloTPOTms: 50,
};

export const STEP_MS = 20;
export const PREFIX_FAMILIES = ['chat', 'code', 'docs'] as const;
export const active = (r: Request) => r.status === 'prefill' || r.status === 'decode';
/** Requests that hold resources (blocks or reservation) on a pool. */
export const holding = (r: Request) =>
  r.status === 'prefill' || r.status === 'decode' || r.status === 'decode_wait' ||
  r.status === 'transfer_wait' || r.status === 'transferring';
export const terminal = (r: Request) =>
  r.status === 'completed' || r.status === 'cancelled' || r.status === 'rejected';
export const contextTarget = (r: Request) => r.promptTokens + r.generated;
/** KV tokens a pool must still be able to hold for this request (conservative reservation). */
export const reservedTokens = (r: Request, kind: PoolKind) =>
  kind === 'prefill' ? r.promptTokens : r.promptTokens + r.outputTokens;
/** Blocks still to be allocated under the conservative reservation. */
export const debtBlocks = (r: Request, kind: PoolKind, blockSize: number) =>
  Math.ceil(reservedTokens(r, kind) / blockSize) - r.blockTable.length;
/** Bytes of KV payload per token from the interpretable size model. */
export const bytesPerToken = (c: Config) => 2 * c.numLayers * c.numKVHeads * c.headDim * c.bytesPerElement;

export const finiteInt = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(Number.isFinite(n) ? n : min)));

const TP_OPTIONS = [1, 2, 4, 8];
const GPU_OPTIONS = [1, 2, 4, 8];

export function normalizeConfig(partial: Partial<Config>): Config {
  const c: Config = { ...DEFAULT_CONFIG, ...partial };
  c.gpuCount = GPU_OPTIONS.includes(c.gpuCount) ? c.gpuCount : 2;
  c.tensorParallel = TP_OPTIONS.filter(x => x <= c.tensorParallel && c.gpuCount % x === 0).at(-1) ?? 1;
  c.blockSize = [8, 16, 32, 64].includes(c.blockSize) ? c.blockSize : 16;
  c.numBlocks = finiteInt(c.numBlocks, 16, 512);
  c.maxBatchSize = finiteInt(c.maxBatchSize, 1, 16);
  c.maxNumBatchedTokens = Math.max(c.maxBatchSize, finiteInt(c.maxNumBatchedTokens, 8, 65536));
  c.prefillChunkSize = c.prefillChunkSize > 0 ? finiteInt(c.prefillChunkSize, 8, 8192) : 0;
  c.kvWatermark = Number.isFinite(c.kvWatermark) ? Math.min(0.5, Math.max(0, c.kvWatermark)) : 0;
  c.schedulerPolicy = ['fcfs', 'sjf', 'priority', 'slo'].includes(c.schedulerPolicy) ? c.schedulerPolicy : 'fcfs';
  c.preemptionMode = ['none', 'prefill-only', 'cost-aware'].includes(c.preemptionMode) ? c.preemptionMode
    : c.preemptionMode === 'recompute' ? 'cost-aware' : 'none';
  c.preemptionCooldownMs = finiteInt(c.preemptionCooldownMs, 0, 60000);
  c.starvationThresholdMs = finiteInt(c.starvationThresholdMs, 0, 600000);
  c.transferSchedulingPolicy = ['fair-share', 'fifo', 'priority'].includes(c.transferSchedulingPolicy)
    ? c.transferSchedulingPolicy : 'fair-share';
  c.maxPendingDecodeRequests = finiteInt(c.maxPendingDecodeRequests, 0, 256);
  c.servingMode = c.servingMode === 'disaggregated' ? 'disaggregated' : 'monolithic';
  c.specDraftLength = finiteInt(c.specDraftLength, 1, 16);
  c.specAcceptance = ['low', 'medium', 'high'].includes(c.specAcceptance) ? c.specAcceptance : 'medium';
  c.specCost = Number.isFinite(c.specCost) ? Math.min(4, Math.max(1, c.specCost)) : 1.65;
  c.numLayers = finiteInt(c.numLayers, 1, 128);
  c.numKVHeads = finiteInt(c.numKVHeads, 1, 128);
  c.headDim = finiteInt(c.headDim, 32, 512);
  c.bytesPerElement = [1, 2, 4].includes(c.bytesPerElement) ? c.bytesPerElement : 2;
  c.sloTTFTms = finiteInt(c.sloTTFTms, 20, 60000);
  c.sloTPOTms = finiteInt(c.sloTPOTms, 5, 60000);
  c.kvTransferBandwidthGBps = finiteInt(c.kvTransferBandwidthGBps, 1, 400);
  c.kvTransferLatencyUs = finiteInt(c.kvTransferLatencyUs, 0, 100000);
  c.maxConcurrentTransfers = finiteInt(c.maxConcurrentTransfers, 1, 16);
  c.kvTiers = ['gpu', 'gpu-cpu', 'gpu-cpu-remote'].includes(c.kvTiers) ? c.kvTiers : 'gpu';
  c.cpuKvBlocks = finiteInt(c.cpuKvBlocks, 0, 8192);
  c.remoteKvBlocks = finiteInt(c.remoteKvBlocks, 0, 65536);
  c.cpuRestoreBandwidthGBps = finiteInt(c.cpuRestoreBandwidthGBps, 1, 400);
  c.remoteRestoreBandwidthGBps = finiteInt(c.remoteRestoreBandwidthGBps, 1, 400);
  c.cpuRestoreLatencyMs = finiteInt(c.cpuRestoreLatencyMs, 0, 1000);
  c.remoteRestoreLatencyMs = finiteInt(c.remoteRestoreLatencyMs, 0, 1000);
  if (c.servingMode === 'disaggregated') {
    // Keep the total GPU allocation legal by construction: the prefill pool
    // takes its share and decode gets the remaining GPUs.
    const pre = finiteInt(c.prefillGpuCount, 1, c.gpuCount - 1);
    const dec = c.gpuCount - pre;
    c.prefillGpuCount = pre;
    c.decodeGpuCount = dec;
    c.prefillTP = TP_OPTIONS.filter(x => x <= c.prefillTP && pre % x === 0).at(-1) ?? 1;
    c.decodeTP = TP_OPTIONS.filter(x => x <= c.decodeTP && dec % x === 0).at(-1) ?? 1;
  } else {
    c.prefillGpuCount = c.gpuCount;
    c.decodeGpuCount = c.gpuCount;
    c.prefillTP = c.tensorParallel;
    c.decodeTP = c.tensorParallel;
  }
  return c;
}

/** Last full block count of n tokens. */
export const blocksFor = (tokens: number, blockSize: number) => Math.ceil(tokens / blockSize);
