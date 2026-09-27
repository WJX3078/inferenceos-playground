// InferenceOS Lab simulation engine — deterministic orchestrator.
//
// The engine owns: the simulation clock, the step orchestration, request
// intake/cancellation, transfer & restore ticking, worker snapshots, metrics
// composition, invariants and run export. Subsystem algorithms live in their
// own modules (scheduler/, runtime/{lifecycle,accounting,admission,preemption,
// executor}.ts, cache/transfer/workload/metrics). The runtime controllers
// receive the engine itself as a structural "host" and read every field
// through it, so live config replacement is always visible and no state is
// aliased.
//
// Deterministic: same seed + config + workload + action ordering => identical
// results. No wall-clock time enters any decision.

import { KVCacheManager } from './cache.ts';
import { MetricsCollector } from './metrics.ts';
import { createScheduler, type Scheduler } from './scheduler/index.ts';
import { KVTransferManager, type TransferRecord } from './transfer.ts';
import { createRng, fnv1a, type Rng } from './rng.ts';
import { transitionRequest } from './runtime/lifecycle.ts';
import { poolBlockOwners, poolDebt, poolRequests, usableCapacity } from './runtime/accounting.ts';
import { AdmissionController } from './runtime/admission.ts';
import { PoolExecutor } from './runtime/executor.ts';
import { PreemptionController } from './runtime/preemption.ts';
import {
  active, bytesPerToken, contextTarget, debtBlocks, finiteInt, normalizeConfig,
  PREFIX_FAMILIES, STEP_MS, terminal,
} from './types.ts';
import type {
  BudgetUsage, Config, Metrics, PoolKind, Request, RequestInput, Sample,
  SchedulerEvent, Worker,
} from './types.ts';
import { WorkloadGenerator, defaultTraffic, type TrafficSpec } from './workload.ts';

export type LiveFeatureKey =
  | 'continuousBatching' | 'prefixCaching' | 'speculativeDecoding'
  | 'schedulerPolicy' | 'maxBatchSize' | 'maxNumBatchedTokens' | 'prefillChunkSize' | 'decodePriority'
  | 'preemptionMode' | 'preemptionCooldownMs' | 'starvationThresholdMs' | 'kvWatermark'
  | 'specDraftLength' | 'specAcceptance' | 'specCost'
  | 'sloTTFTms' | 'sloTPOTms' | 'kvTransferBandwidthGBps' | 'maxConcurrentTransfers'
  | 'transferSchedulingPolicy' | 'maxPendingDecodeRequests';

const LIVE_FEATURES: LiveFeatureKey[] = [
  'continuousBatching', 'prefixCaching', 'speculativeDecoding',
  'schedulerPolicy', 'maxBatchSize', 'maxNumBatchedTokens', 'prefillChunkSize', 'decodePriority',
  'preemptionMode', 'preemptionCooldownMs', 'starvationThresholdMs', 'kvWatermark',
  'specDraftLength', 'specAcceptance', 'specCost',
  'sloTTFTms', 'sloTPOTms', 'kvTransferBandwidthGBps', 'maxConcurrentTransfers',
  'transferSchedulingPolicy', 'maxPendingDecodeRequests',
];

const QUEUE_CAP = 256;
const TRAFFIC_BACKOFF = 128;
const HISTORY_LIMIT = 160;
const EVENT_LIMIT = 150;

export class SimulationEngine {
  config: Config;
  now = 0;
  requests: Request[] = [];
  pools: KVCacheManager[];
  poolKinds: PoolKind[];
  workers: Worker[] = [];
  events: SchedulerEvent[] = [];
  samples: Sample[] = [];
  readonly collector = new MetricsCollector();
  transfers: KVTransferManager;
  restores: KVTransferManager;
  scheduler: Scheduler;
  workload: WorkloadGenerator | null = null;
  iterations = 0;
  lastBudget: BudgetUsage[];
  readonly admission: AdmissionController;
  private readonly executor: PoolExecutor;
  readonly preemption: PreemptionController;
  private readonly rngFn: Rng;
  private readonly seedBase: number;
  private serial = 0;
  private eventSerial = 0;
  readonly pendingRestores = new Map<string, { pool: number; hashes: string[] }>();
  private networkBusyEma = 0;

  constructor(config: Partial<Config> = {}, seed = 73) {
    const c = this.config = normalizeConfig(config);
    this.seedBase = seed >>> 0;
    this.rngFn = createRng(this.seedBase);
    const tierCfg = () => ({
      mode: c.kvTiers,
      cpuBlocks: c.cpuKvBlocks,
      remoteBlocks: c.remoteKvBlocks,
      blockBytes: c.blockSize * bytesPerToken(c),
    });
    if (c.servingMode === 'disaggregated') {
      this.pools = [];
      this.poolKinds = [];
      const prefillReplicas = c.prefillGpuCount / c.prefillTP;
      const decodeReplicas = c.decodeGpuCount / c.decodeTP;
      for (let i = 0; i < prefillReplicas; i++) { this.pools.push(new KVCacheManager(c.numBlocks, c.blockSize, 'prefill', tierCfg())); this.poolKinds.push('prefill'); }
      for (let i = 0; i < decodeReplicas; i++) { this.pools.push(new KVCacheManager(c.numBlocks, c.blockSize, 'decode', tierCfg())); this.poolKinds.push('decode'); }
    } else {
      const replicas = c.gpuCount / c.tensorParallel;
      this.pools = Array.from({ length: replicas }, () => new KVCacheManager(c.numBlocks, c.blockSize, 'both', tierCfg()));
      this.poolKinds = Array.from({ length: replicas }, () => 'both' as PoolKind);
    }
    let workerId = 0;
    for (let p = 0; p < this.pools.length; p++) {
      const tp = this.poolTP(p);
      for (let rank = 0; rank < tp; rank++) {
        this.workers.push({
          id: workerId++, group: p, rank, kind: this.poolKinds[p],
          requestIds: [], utilization: 0, phase: 'idle',
        });
      }
    }
    this.lastBudget = this.pools.map(() => ({ total: c.maxNumBatchedTokens, decode: 0, prefill: 0, unused: c.maxNumBatchedTokens }));
    this.scheduler = createScheduler(c.schedulerPolicy, () => this.prefillCapacity());
    this.transfers = new KVTransferManager(() => ({
      bandwidthGBps: this.config.kvTransferBandwidthGBps,
      latencyMs: this.config.kvTransferLatencyUs / 1000,
      maxConcurrent: this.config.maxConcurrentTransfers,
      policy: this.config.transferSchedulingPolicy,
    }));
    this.restores = new KVTransferManager(() => ({
      bandwidthGBps: this.config.cpuRestoreBandwidthGBps,
      latencyMs: this.config.cpuRestoreLatencyMs,
      maxConcurrent: 8,
      policy: 'fair-share' as const,
    }));
    this.executor = new PoolExecutor(this);
    this.preemption = new PreemptionController(this);
    this.admission = new AdmissionController(this);
  }

  // ---------- helpers ----------

  /** Deterministic RNG stream shared by traffic generation and speculation. */
  rng(): number { return this.rngFn(); }

  ctx() { return { config: this.config, now: this.now }; }
  poolTP(p: number) {
    const kind = this.poolKinds[p];
    return kind === 'prefill' ? this.config.prefillTP : kind === 'decode' ? this.config.decodeTP : this.config.tensorParallel;
  }
  usable(p: number) { return usableCapacity(this.config, this.pools[p]); }
  prefillCapacity() {
    const c = this.config;
    return c.prefillChunkSize > 0 ? Math.min(c.prefillChunkSize, c.maxNumBatchedTokens) : c.maxNumBatchedTokens;
  }
  poolRequests(p: number): Request[] { return poolRequests(this.requests, this.poolKinds, p); }
  poolDebt(p: number): number { return poolDebt(this.config, this.requests, this.poolKinds, p); }
  event(type: string, message: string, requestId?: string) {
    this.events.unshift({ id: ++this.eventSerial, at: this.now, type, message, requestId });
    this.events.length = Math.min(EVENT_LIMIT, this.events.length);
  }
  waitEvent(r: Request, reason: string) {
    if (r.reason !== reason) { r.reason = reason; this.event('wait', reason, r.id); }
  }

  // ---------- request intake ----------

  enqueue(input: RequestInput): Request {
    const c = this.config;
    const promptTokens = finiteInt(input.promptTokens, 1, 8192);
    const prefix = (PREFIX_FAMILIES as readonly string[]).includes(input.prefix) ? input.prefix : 'none';
    const id = `R${String(++this.serial).padStart(3, '0')}`;
    const r: Request = {
      ...input,
      promptTokens,
      outputTokens: finiteInt(input.outputTokens, 1, 1024),
      prefix,
      priority: input.priority === 'low' || input.priority === 'high' ? input.priority : 'normal',
      sloTTFT: input.sloTTFTms ?? c.sloTTFTms,
      sloTPOT: input.sloTPOTms ?? c.sloTPOTms,
      tokenSeed: fnv1a(this.seedBase, this.serial, 0x51ed),
      id,
      arrivedAt: this.now,
      status: 'waiting',
      group: null, prefillGroup: null, decodeGroup: null,
      processed: 0, generated: 0, cachedTokens: 0,
      prefixTokens: prefix === 'none' ? 0 : Math.min(128, Math.floor(promptTokens / 2 / c.blockSize) * c.blockSize),
      blockTable: [], compute: 0, reason: 'Awaiting scheduler', spans: [],
      preemptions: 0, recomputedTokens: 0,
      transfer: null, pendingRestoreCount: 0, tierHit: null,
      resumeTarget: null, starvedSince: null,
      observed: input.observed,
      speculative: null,
    };
    this.requests.push(r);
    if (Math.ceil((r.promptTokens + r.outputTokens) / c.blockSize) > c.numBlocks) {
      transitionRequest(r, 'rejected', 'context exceeds pool');
      r.finishedAt = this.now;
      r.reason = 'Context exceeds one replica KV pool';
      this.collector.rejected++;
      this.collector.record(r, this.now);
      this.event('reject', r.reason, r.id);
    } else if (this.requests.filter(x => x.status === 'waiting').length > QUEUE_CAP) {
      transitionRequest(r, 'rejected', 'queue cap');
      r.finishedAt = this.now; r.reason = `Queue limit: ${QUEUE_CAP}`;
      this.collector.rejected++;
      this.collector.record(r, this.now);
      this.event('reject', r.reason, r.id);
    } else {
      this.event('arrival', `${promptTokens} prompt / ${r.outputTokens} output tokens / ${r.priority}`, r.id);
    }
    return r;
  }

  burst(count: number, input: RequestInput) {
    return Array.from({ length: finiteInt(count, 1, 64) }, () => this.enqueue({
      ...input,
      promptTokens: Math.max(1, Math.round(input.promptTokens * (0.5 + this.rng()))),
      outputTokens: Math.max(1, Math.round(input.outputTokens * (0.5 + this.rng()))),
    }));
  }

  setTraffic(spec: Partial<TrafficSpec> | null) {
    if (!spec) { this.workload = null; return; }
    const merged = { ...defaultTraffic(this.workload?.current.rate ?? 2), ...spec };
    this.workload = new WorkloadGenerator(merged, this.rngFn, this.now);
  }

  updateTraffic(patch: Partial<TrafficSpec>) {
    if (!this.workload) { this.setTraffic(patch); return; }
    this.workload.update(patch);
  }

  setFeatures(features: Partial<Config>) {
    const patch: Partial<Config> = {};
    for (const key of LIVE_FEATURES) if (key in features) (patch as Record<string, unknown>)[key] = features[key as keyof Config];
    const prevPolicy = this.config.schedulerPolicy;
    this.config = normalizeConfig({ ...this.config, ...patch });
    if (this.config.schedulerPolicy !== prevPolicy) {
      this.scheduler = createScheduler(this.config.schedulerPolicy, () => this.prefillCapacity());
    }
    if (!this.config.prefixCaching) this.pools.forEach(p => p.clearUnused());
    this.event('config', `Updated: ${Object.keys(patch).join(', ') || 'no changes'}`);
  }

  cancel(id: string) {
    const r = this.requests.find(x => x.id === id);
    if (!r || terminal(r)) return;
    if (r.pendingRestoreCount > 0) {
      this.restores.cancel(id);
      for (const k of [...this.pendingRestores.keys()]) if (k.startsWith(id + ':')) this.pendingRestores.delete(k);
      r.pendingRestoreCount = 0;
    }
    if (r.transfer) this.transfers.cancel(id);
    if (r.group !== null) this.pools[r.group].release(r, this.config.prefixCaching, this.now);
    transitionRequest(r, 'cancelled', 'operator');
    r.finishedAt = this.now;
    r.reason = 'Cancelled by operator';
    r.group = null;
    r.blockTable = [];
    this.collector.cancelled++;
    this.collector.record(r, this.now);
    this.event('cancel', 'Pages released', id);
    this.updateWorkers();
  }

  /** Release a preemption victim's KV ownership and execution progress. */
  releaseVictim(victim: Request) {
    if (victim.group !== null) this.pools[victim.group].release(victim, this.config.prefixCaching, this.now);
    victim.group = null;
    victim.blockTable = [];
    victim.processed = 0;
    victim.cachedTokens = 0;
    victim.compute = 0;
  }

  /** Release a transferred request's prefill-pool blocks (the decode pool owns it now). */
  releasePrefillBlocks(r: Request) {
    if (r.prefillGroup !== null) this.pools[r.prefillGroup].release(r, this.config.prefixCaching, this.now);
  }

  // ---------- main loop ----------

  step(count = 1) {
    const c = this.config;
    for (let tick = 0; tick < finiteInt(count, 1, 10000); tick++) {
      if (this.workload) {
        for (const input of this.workload.tick(this.now, STEP_MS)) {
          if (this.requests.filter(x => x.status === 'waiting').length < TRAFFIC_BACKOFF) this.enqueue(input);
        }
      }
      this.admission.admit();
      const start = this.now;
      this.now += STEP_MS;
      for (let p = 0; p < this.pools.length; p++) this.executor.runIteration(p, start);
      if (c.servingMode === 'disaggregated') {
        for (const r of this.requests) if (r.status === 'transfer_wait' && !r.transfer) this.executor.stageTransfer(r);
        this.transfers.tick(STEP_MS, this.now,
          rec => this.executor.completeTransfer(rec),
          rec => this.executor.startTransfer(rec));
      }
      this.restores.tick(STEP_MS, this.now, rec => this.completeRestore(rec), () => undefined);
      this.executor.recordPhaseSpans(start, ['transfer_wait', 'transferring', 'decode_wait']);
      this.updateWorkers();
      if (this.now % 100 === 0) {
        const m = this.metrics;
        this.samples.push({ at: this.now, tokens: m.tokensPerSecond, gpu: m.gpuUtilization, kv: m.kvUtilization });
        if (this.samples.length > 180) this.samples.shift();
      }
      this.iterations++;
      const terminalRequests = this.requests.filter(r => terminal(r));
      const drop = new Set(terminalRequests.slice(0, Math.max(0, terminalRequests.length - HISTORY_LIMIT)).map(r => r.id));
      if (drop.size) this.requests = this.requests.filter(r => !drop.has(r.id));
    }
  }

  private completeRestore(rec: TransferRecord) {
    const key = `${rec.requestId}:${rec.source}`;
    const pending = this.pendingRestores.get(key);
    this.pendingRestores.delete(key);
    const r = this.requests.find(x => x.id === rec.requestId);
    if (!r || terminal(r) || !pending) return;
    this.pools[pending.pool].restoreBlocks(pending.hashes, this.now);
    this.collector.restoreBytes += rec.bytes;
    r.pendingRestoreCount = Math.max(0, r.pendingRestoreCount - 1);
    r.tierHit = rec.source as 'cpu' | 'remote';
    r.reason = 'KV restored; awaiting admission';
    this.event('restore-complete', `${pending.hashes.length} blocks restored from ${rec.source} tier`, r.id);
  }

  // ---------- observability ----------

  updateWorkers() {
    const c = this.config;
    for (const w of this.workers) {
      const batch = this.requests.filter(r => r.group === w.group && active(r)
        && (w.kind !== 'prefill' || r.status === 'prefill') && (w.kind !== 'decode' || r.status === 'decode'));
      w.requestIds = batch.map(r => r.id);
      const prefill = batch.some(r => r.status === 'prefill');
      const decode = batch.some(r => r.status === 'decode');
      w.phase = prefill && decode ? 'mixed' : prefill ? 'prefill' : decode ? 'decode' : 'idle';
      if (w.kind === 'prefill') w.utilization = prefill ? Math.min(99, 48 + batch.length / c.maxBatchSize * 48) : 0;
      else if (w.kind === 'decode') w.utilization = decode ? Math.min(99, 25 + batch.length / c.maxBatchSize * 48) : 0;
      else w.utilization = batch.length ? Math.min(99, (prefill ? 48 : 25) + batch.length / c.maxBatchSize * 48) : 0;
    }
  }

  get metrics(): Metrics {
    const base = this.collector.read(this.now);
    const totalBlocks = this.pools.length * this.config.numBlocks;
    const occupied = this.pools.reduce((n, p) => n + p.occupied, 0);
    const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const bothWorkers = this.workers.filter(w => w.kind === 'both');
    const prefillWorkers = this.workers.filter(w => w.kind === 'prefill');
    const decodeWorkers = this.workers.filter(w => w.kind === 'decode');
    const pipeBusy = this.transfers.active.length > 0 ? 1 : 0;
    this.networkBusyEma = this.networkBusyEma * 0.95 + pipeBusy * 0.05;
    return {
      ...base,
      active: this.requests.filter(active).length,
      waiting: this.requests.filter(r => r.status === 'waiting').length,
      preempted: this.requests.filter(r => r.status === 'preempted').length,
      inTransfer: this.requests.filter(r => r.status === 'transfer_wait' || r.status === 'transferring').length,
      kvUtilization: occupied / totalBlocks * 100,
      gpuUtilization: mean(this.workers.map(w => w.utilization)),
      prefillUtilization: mean([...bothWorkers, ...prefillWorkers].map(w => w.utilization)),
      decodeUtilization: mean([...bothWorkers, ...decodeWorkers].map(w => w.utilization)),
      evictions: this.pools.reduce((n, p) => n + p.evictions, 0),
      tokenBudgetUtilization: this.executor.budgetEma * 100,
      schedulerIterations: this.iterations,
      networkBytes: this.transfers.bytesTotal,
      transfersActive: this.transfers.active.length,
      transfersQueued: this.transfers.queue.length,
      transfersCompleted: this.transfers.completed,
      restores: this.restores.completed,
      tierBytesMoved: this.pools.reduce((n, p) => n + p.demoteBytes + p.restoreBytes, 0),
      networkUtilization: this.networkBusyEma * 100,
    };
  }

  // ---------- correctness ----------

  assertInvariants() {
    const c = this.config;
    const bs = c.blockSize;
    const byId = new Map(this.requests.map(r => [r.id, r] as const));
    for (let p = 0; p < this.pools.length; p++) {
      const usage = this.lastBudget[p];
      if (usage.decode + usage.prefill > usage.total || usage.total > c.maxNumBatchedTokens) {
        throw new Error('Token budget exceeded');
      }
    }
    for (const r of this.requests) {
      if (new Set(r.blockTable).size !== r.blockTable.length) throw new Error('Duplicate page');
      if (r.generated > r.outputTokens) throw new Error('Output overflow');
      if (r.processed > contextTarget(r)) throw new Error('Prefill overflow');
      if (r.resumeTarget !== null && r.processed > r.resumeTarget) throw new Error('Recompute overflow');
      const poolIdx = this.ownerPool(r);
      if (poolIdx === null) continue;
      const pool = this.pools[poolIdx];
      for (const id of r.blockTable) if (!pool.blocks[id].owners.includes(r.id)) throw new Error('Missing page owner');
      if (r.status === 'decode' && c.servingMode === 'disaggregated') {
        if (!r.transfer || r.transfer.finishedAt === undefined) throw new Error('Decode admitted before KV transfer finished');
      }
      if (r.status === 'transfer_wait' && !r.transfer && !r.reason.includes('Decode pool KV pressure')) {
        throw new Error('transfer_wait neither staged nor waiting for decode-pool capacity');
      }
      if (r.status === 'transferring' && (!r.transfer || r.transfer.startedAt === undefined)) throw new Error('transferring without started transfer');
    }
    for (let p = 0; p < this.pools.length; p++) {
      const pool = this.pools[p];
      let debt = 0;
      for (const r of this.poolRequests(p)) debt += Math.max(0, debtBlocks(r, this.poolKinds[p], bs));
      if (pool.pinned > pool.capacity) throw new Error('Overallocated KV pool');
      if (pool.pinned + debt > pool.capacity) throw new Error('Overcommitted KV');
      const ownerIds = new Set(poolBlockOwners(this.requests, c.servingMode, p).map(r => r.id));
      for (const b of pool.blocks) {
        if (b.used > bs) throw new Error('Block overflow');
        for (const id of b.owners) {
          if (!ownerIds.has(id)) throw new Error('Leaked owner');
          const owner = byId.get(id);
          if (!owner || !owner.blockTable.includes(b.id)) throw new Error('Leaked owner');
        }
        if (b.owners.length > 1 && !b.key) throw new Error('Mutable shared page');
      }
    }
    for (const rec of [...this.transfers.queue, ...this.transfers.active]) {
      const r = byId.get(rec.requestId);
      if (!r || terminal(r)) throw new Error('Dead request still in transfer pipeline');
      if (r.status !== 'transfer_wait' && r.status !== 'transferring') throw new Error('Transfer state mismatch');
    }
    for (const r of this.requests) {
      if (r.status === 'preempted' && (r.blockTable.length || r.group !== null)) throw new Error('Preempted request still holds KV');
      if (r.spans.some(s => s.end < s.start || !Number.isFinite(s.end))) throw new Error('Negative span');
    }
    for (const w of this.workers) {
      for (const id of w.requestIds) {
        const r = byId.get(id);
        if (!r || !active(r)) throw new Error('Worker schedules non-active request');
      }
    }
    const finite = (v: number) => Number.isFinite(v);
    if (!finite(this.collector.outputTokens) || this.collector.outputTokens < 0) throw new Error('Bad output counter');
    if (!finite(this.now) || this.now < 0) throw new Error('Bad clock');
  }

  private ownerPool(r: Request): number | null {
    if (terminal(r) || r.status === 'preempted' || r.status === 'waiting') return null;
    if (this.config.servingMode === 'monolithic') return r.group;
    return r.status === 'decode' || r.status === 'decode_wait' ? r.decodeGroup : r.prefillGroup;
  }

  /** Export the current run for replay: same seed + config + workload reproduces it. */
  exportRun() {
    return {
      schemaVersion: 2,
      simulatedMs: this.now,
      iterations: this.iterations,
      seed: this.seedBase,
      config: this.config,
      traffic: this.workload?.current ?? null,
      metrics: this.metrics,
      requests: this.requests,
      observations: this.collector.observations,
      events: this.events,
      samples: this.samples,
      transfers: { completed: this.transfers.log, bytesTotal: this.transfers.bytesTotal },
    };
  }
}
