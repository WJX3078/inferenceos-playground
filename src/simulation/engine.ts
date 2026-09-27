// InferenceOS Lab simulation engine.
//
// Deterministic, fixed-step (20 ms) serving-system simulator:
// workload generator -> admission (scheduler-ordered, watermark-aware,
// preemption-capable) -> per-replica scheduler iterations with a global token
// budget, chunked prefill and decode priority -> paged KV cache with
// content-addressed prefix sharing and optional multi-tier hierarchy ->
// optional prefill/decode disaggregation with a KV transfer manager ->
// request-level metrics with percentiles, SLO and goodput.
//
// The engine never touches wall-clock time and owns all feasibility checks;
// scheduler policies only order work.

import { KVCacheManager } from './cache.ts';
import { MetricsCollector } from './metrics.ts';
import { createScheduler, type Scheduler } from './scheduler/index.ts';
import { KVTransferManager, type TransferRecord } from './transfer.ts';
import { createRng, fnv1a, type Rng } from './rng.ts';
import {
  active, blocksFor, bytesPerToken, contextTarget, debtBlocks, finiteInt, holding,
  normalizeConfig, PREFIX_FAMILIES, reservedTokens, STEP_MS, terminal,
} from './types.ts';
import type {
  BudgetUsage, Config, Metrics, Phase, PoolKind, Request, RequestInput, Sample,
  SchedulerEvent, Worker,
} from './types.ts';
import { WorkloadGenerator, defaultTraffic, type TrafficSpec } from './workload.ts';

export type LiveFeatureKey =
  | 'continuousBatching' | 'prefixCaching' | 'speculativeDecoding'
  | 'schedulerPolicy' | 'maxBatchSize' | 'maxNumBatchedTokens' | 'prefillChunkSize' | 'decodePriority'
  | 'preemptionMode' | 'kvWatermark' | 'specDraftLength' | 'specAcceptance' | 'specCost'
  | 'sloTTFTms' | 'sloTPOTms' | 'kvTransferBandwidthGBps' | 'maxConcurrentTransfers';

const LIVE_FEATURES: LiveFeatureKey[] = [
  'continuousBatching', 'prefixCaching', 'speculativeDecoding',
  'schedulerPolicy', 'maxBatchSize', 'maxNumBatchedTokens', 'prefillChunkSize', 'decodePriority',
  'preemptionMode', 'kvWatermark', 'specDraftLength', 'specAcceptance', 'specCost',
  'sloTTFTms', 'sloTPOTms', 'kvTransferBandwidthGBps', 'maxConcurrentTransfers',
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
  budgetEma = 0;
  lastBudget: BudgetUsage[];
  private rng: Rng;
  private seedBase: number;
  private serial = 0;
  private eventSerial = 0;
  private pendingRestores = new Map<string, { pool: number; hashes: string[] }>();

  constructor(config: Partial<Config> = {}, seed = 73) {
    const c = this.config = normalizeConfig(config);
    this.seedBase = seed >>> 0;
    this.rng = createRng(this.seedBase);
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
    const transferOpts = () => ({
      bandwidthGBps: this.config.kvTransferBandwidthGBps,
      latencyMs: this.config.kvTransferLatencyUs / 1000,
      maxConcurrent: this.config.maxConcurrentTransfers,
    });
    this.transfers = new KVTransferManager(transferOpts);
    this.restores = new KVTransferManager(() => ({
      bandwidthGBps: this.config.cpuRestoreBandwidthGBps,
      latencyMs: this.config.cpuRestoreLatencyMs,
      maxConcurrent: 8,
    }));
  }

  // ---------- helpers ----------

  private ctx() { return { config: this.config, now: this.now }; }
  poolTP(p: number) {
    const kind = this.poolKinds[p];
    return kind === 'prefill' ? this.config.prefillTP : kind === 'decode' ? this.config.decodeTP : this.config.tensorParallel;
  }
  private usable(p: number) {
    return this.pools[p].capacity - Math.floor(this.pools[p].capacity * this.config.kvWatermark);
  }
  private prefillCapacity() {
    const c = this.config;
    return c.prefillChunkSize > 0 ? Math.min(c.prefillChunkSize, c.maxNumBatchedTokens) : c.maxNumBatchedTokens;
  }
  /** Requests that hold KV blocks (or a reservation) on pool p. */
  poolRequests(p: number): Request[] {
    const kind = this.poolKinds[p];
    return this.requests.filter(r => {
      if (kind === 'both') return r.group === p && holding(r);
      if (kind === 'prefill') return r.prefillGroup === p && (r.status === 'prefill' || r.status === 'transfer_wait' || r.status === 'transferring');
      return r.decodeGroup === p && holding(r);
    });
  }
  /** Unallocated reservation blocks a request holds on pool p.
   *  Transfer-phase requests keep their prompt blocks on the prefill pool, so
   *  the decode pool must still reserve their FULL prompt+output footprint. */
  private debtOnPool(r: Request, p: number): number {
    const kind = this.poolKinds[p];
    if (kind === 'decode' && (r.status === 'transfer_wait' || r.status === 'transferring')) {
      return blocksFor(reservedTokens(r, 'decode'), this.config.blockSize);
    }
    return Math.max(0, debtBlocks(r, kind, this.config.blockSize));
  }
  /** Sum of unallocated reservation blocks held on pool p. */
  private poolDebt(p: number): number {
    let debt = 0;
    for (const r of this.poolRequests(p)) debt += this.debtOnPool(r, p);
    return debt;
  }
  private event(type: string, message: string, requestId?: string) {
    this.events.unshift({ id: ++this.eventSerial, at: this.now, type, message, requestId });
    this.events.length = Math.min(EVENT_LIMIT, this.events.length);
  }
  private waitEvent(r: Request, reason: string) {
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
      transfer: null, restore: null, tierHit: null,
      resumeTarget: null,
      speculative: null,
    };
    this.requests.push(r);
    if (Math.ceil((r.promptTokens + r.outputTokens) / c.blockSize) > c.numBlocks) {
      r.status = 'rejected'; r.finishedAt = this.now;
      r.reason = 'Context exceeds one replica KV pool';
      this.collector.rejected++;
      this.collector.record(r, this.now);
      this.event('reject', r.reason, r.id);
    } else if (this.requests.filter(x => x.status === 'waiting').length > QUEUE_CAP) {
      r.status = 'rejected'; r.finishedAt = this.now; r.reason = `Queue limit: ${QUEUE_CAP}`;
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
    this.workload = new WorkloadGenerator(merged, this.rng, this.now);
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
    if (r.restore) { this.restores.cancel(id); this.pendingRestores.delete(id); r.restore = null; }
    if (r.transfer) this.transfers.cancel(id);
    if (r.group !== null) this.pools[r.group].release(r, this.config.prefixCaching, this.now);
    r.status = 'cancelled'; r.finishedAt = this.now; r.reason = 'Cancelled by operator';
    r.group = null;
    r.blockTable = [];
    this.collector.cancelled++;
    this.collector.record(r, this.now);
    this.event('cancel', 'Pages released', id);
    this.updateWorkers();
  }

  // ---------- admission ----------

  private admit() {
    const c = this.config;
    if (c.servingMode === 'disaggregated') this.admitDecodePools();
    const queue = this.requests.filter(r => r.status === 'waiting' || r.status === 'preempted');
    if (!queue.length) return;
    const ordered = this.scheduler.order(queue, this.ctx());
    const poolIdx = this.pools.map((_, i) => i)
      .filter(i => c.servingMode === 'monolithic' || this.poolKinds[i] === 'prefill');
    for (const r of ordered) {
      if (r.restore) continue; // waiting for a tier restore to land
      const candidates = poolIdx.map(p => {
        const pool = this.pools[p];
        const kind = this.poolKinds[p];
        const batch = this.requests.filter(x =>
          (kind === 'both' ? x.group === p : x.prefillGroup === p) && active(x));
        const cached = c.prefixCaching && kind !== 'decode' ? pool.match(r) : [];
        const newlyPinned = cached.filter(id => !pool.blocks[id].owners.length).length;
        const required = blocksFor(reservedTokens(r, kind), c.blockSize);
        const reservation = pool.pinned + this.poolDebt(p);
        const hardFits = reservation + newlyPinned + required - cached.length <= pool.capacity;
        const fits = hardFits && reservation + newlyPinned + required - cached.length <= this.usable(p);
        const staticBusy = !c.continuousBatching && batch.some(x => x.admittedAt !== this.now);
        return { p, pool, kind, batch, cached, required, reservation, fits, hardFits, staticBusy };
      }).sort((a, b) => a.batch.length - b.batch.length || b.cached.length - a.cached.length || a.p - b.p);
      const target = candidates.find(x => x.fits && !x.staticBusy && x.batch.length < c.maxBatchSize);
      if (!target) {
        if (!this.tryPreempt(r, candidates)) {
          const reason = !candidates.some(x => x.hardFits) ? 'KV reservation pressure'
            : !candidates.some(x => x.fits) ? `KV watermark reserve (${Math.round(c.kvWatermark * 100)}%)`
            : candidates.some(x => x.staticBusy) ? 'Static cohort draining' : 'Batch slots occupied';
          this.waitEvent(r, reason);
        }
        continue;
      }
      if (c.prefixCaching && c.kvTiers !== 'gpu' && target.kind !== 'decode' && r.prefixTokens > 0) {
        const lookup = target.pool.lookupWithTiers(r);
        if (lookup.missingHashes.length && lookup.tier && !r.restore) {
          const blockBytes = c.blockSize * bytesPerToken(c);
          const bytes = lookup.missingHashes.length * blockBytes;
          const bandwidth = lookup.tier === 'cpu' ? c.cpuRestoreBandwidthGBps : c.remoteRestoreBandwidthGBps;
          const latency = lookup.tier === 'cpu' ? c.cpuRestoreLatencyMs : c.remoteRestoreLatencyMs;
          this.restores.enqueue(r.id, lookup.tier, `gpu:${target.p}`, bytes, this.now, bandwidth, latency);
          this.pendingRestores.set(r.id, { pool: target.p, hashes: lookup.missingHashes });
          r.restore = { tier: lookup.tier, bytes, queuedAt: this.now };
          if (lookup.tier === 'cpu') this.collector.tierHitsCpu++; else this.collector.tierHitsRemote++;
          r.reason = `Restoring ${lookup.missingHashes.length} KV blocks from ${lookup.tier} tier`;
          this.event('restore-queue', r.reason, r.id);
          continue;
        }
        if (lookup.missingHashes.length && !lookup.tier) this.collector.tierRecomputes++;
        else if (!lookup.missingHashes.length) this.collector.tierHitsGpu++;
      }
      this.attachToPool(r, target);
    }
  }

  private attachToPool(r: Request, t: {
    p: number; pool: KVCacheManager; kind: PoolKind; cached: number[];
  }) {
    const c = this.config;
    r.group = t.p;
    r.admittedAt = this.now;
    const resuming = r.status === 'preempted';
    if (t.kind !== 'decode') {
      r.prefillGroup = t.p;
      if (r.prefillAdmittedAt === undefined) r.prefillAdmittedAt = this.now;
    }
    if (resuming) {
      r.resumeTarget = contextTarget(r);
      this.event('resume', `re-admitted to pool ${t.p}; recompute ${contextTarget(r)} context tokens`, r.id);
    }
    t.pool.attach(r, t.cached, this.now);
    r.cachedTokens = t.cached.length * c.blockSize;
    r.processed = r.cachedTokens;
    r.status = 'prefill';
    const kindLabel = t.kind === 'prefill' ? 'prefill pool' : t.kind === 'decode' ? 'decode pool' : 'replica';
    r.reason = `Admitted to ${kindLabel} ${t.p}`;
    if (c.prefixCaching && r.prefixTokens) {
      this.collector.lookups++;
      if (r.cachedTokens) this.collector.hits++;
    }
    this.collector.cachedTokens += r.cachedTokens;
    this.event('admit', `${kindLabel} ${t.p}; ${r.cachedTokens} cached tokens`, r.id);
    if (r.cachedTokens) this.event('prefix', `Reused ${t.cached.length} immutable prefix blocks`, r.id);
  }

  /** Recompute preemption: evict a strictly lower-ranked running request for `candidate`. */
  private tryPreempt(candidate: Request, candidates: {
    p: number; kind: PoolKind; batch: Request[]; staticBusy: boolean; fits: boolean;
  }[]): boolean {
    if (this.config.preemptionMode !== 'recompute') return false;
    for (const t of candidates) {
      if (t.kind === 'decode') continue; // disaggregated decode KV is committed; never preempted
      if (t.staticBusy) continue;
      const victims = t.batch.filter(v => this.scheduler.outranks(candidate, v, this.ctx()));
      if (!victims.length) continue;
      const ordered = this.scheduler.order(victims, this.ctx());
      const victim = ordered[ordered.length - 1]; // least deserving
      this.preempt(victim, candidate);
      return true;
    }
    return false;
  }

  private preempt(victim: Request, by: Request) {
    const pool = this.pools[victim.group!];
    pool.release(victim, this.config.prefixCaching, this.now);
    victim.status = 'preempted';
    victim.preemptions++;
    victim.group = null;
    victim.blockTable = [];
    victim.processed = 0;
    victim.cachedTokens = 0;
    victim.compute = 0;
    this.collector.preemptions++;
    this.event('preempt', `preempted by ${by.id} (${this.scheduler.id}); KV released, context will be recomputed`, victim.id);
    this.updateWorkers();
  }

  /** Disaggregated mode: admit decode_wait requests onto decode pools. */
  private admitDecodePools() {
    const c = this.config;
    for (let p = 0; p < this.pools.length; p++) {
      if (this.poolKinds[p] !== 'decode') continue;
      const candidates = this.requests.filter(r => r.decodeGroup === p && r.status === 'decode_wait');
      if (!candidates.length) continue;
      const ordered = this.scheduler.order(candidates, this.ctx());
      for (const r of ordered) {
        const batch = this.requests.filter(x => x.group === p && active(x));
        if (batch.length >= c.maxBatchSize) { this.waitEvent(r, 'Decode batch slots occupied'); break; }
        if (!c.continuousBatching && batch.some(x => x.admittedAt !== this.now)) {
          this.waitEvent(r, 'Static cohort draining');
          break;
        }
        r.status = 'decode';
        r.group = p;
        r.admittedAt = this.now;
        r.decodeAdmittedAt = this.now;
        r.reason = `Decoding on decode pool ${p}`;
        this.event('admit', `decode pool ${p}; ${r.blockTable.length} blocks resident`, r.id);
      }
    }
  }

  // ---------- scheduler iterations ----------

  step(count = 1) {
    const c = this.config;
    for (let tick = 0; tick < finiteInt(count, 1, 10000); tick++) {
      if (this.workload) {
        for (const input of this.workload.tick(this.now, STEP_MS)) {
          if (this.requests.filter(x => x.status === 'waiting').length < TRAFFIC_BACKOFF) this.enqueue(input);
        }
      }
      this.admit();
      const start = this.now;
      this.now += STEP_MS;
      for (let p = 0; p < this.pools.length; p++) this.runIteration(p, start);
      if (c.servingMode === 'disaggregated') {
        for (const r of this.requests) if (r.status === 'transfer_wait' && !r.transfer) this.stageTransfer(r);
        this.transfers.tick(STEP_MS, this.now,
          rec => this.completeTransfer(rec),
          rec => this.startTransfer(rec));
      }
      this.restores.tick(STEP_MS, this.now, rec => this.completeRestore(rec), () => undefined);
      this.recordPhaseSpans(start, ['transfer_wait', 'transferring', 'decode_wait']);
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

  private runIteration(p: number, start: number) {
    const c = this.config;
    const pool = this.pools[p];
    const kind = this.poolKinds[p];
    const batch = this.requests.filter(r => r.group === p && active(r));
    const total = c.maxNumBatchedTokens;
    if (!batch.length) {
      this.lastBudget[p] = { total, decode: 0, prefill: 0, unused: total };
      this.budgetEma = this.budgetEma * 0.95;
      return;
    }
    const phases = new Map(batch.map(r => [r, r.status] as const));
    const decodes = batch.filter(r => r.status === 'decode').sort((a, b) => a.id.localeCompare(b.id));
    const prefills = batch.filter(r => r.status === 'prefill');
    let decodeUsed = 0;
    let prefillUsed = 0;

    const runDecodes = (avail: number): number => {
      let used = 0;
      const subset = decodes.slice(0, Math.min(decodes.length, Math.max(0, Math.floor(avail))));
      for (const r of subset) {
        used++;
        r.compute += STEP_MS;
        const duration = this.decodeDuration(r, subset.length, kind);
        if (r.compute < duration) continue;
        r.compute -= duration;
        this.emitToken(r, pool);
      }
      return used;
    };

    const runPrefill = (avail: number): number => {
      if (!prefills.length || avail <= 0) return 0;
      const r = this.scheduler.pickPrefill(prefills, this.ctx());
      if (!r) return 0;
      const desired = Math.min(contextTarget(r) - r.processed, c.prefillChunkSize > 0 ? c.prefillChunkSize : Infinity);
      const chunk = Math.min(desired, avail);
      if (chunk <= 0) return 0;
      r.processed += chunk;
      this.ensureKV(pool, r, r.processed);
      if (c.prefillChunkSize > 0) {
        this.event('chunk', `prefill chunk ${chunk} tokens (${r.processed}/${contextTarget(r)})`, r.id);
        if (chunk < desired && decodeUsed > 0) {
          this.event('budget', `prefill truncated by token budget (${chunk}/${Math.round(desired)} tokens this iteration)`, r.id);
        }
      }
      if (r.processed >= contextTarget(r)) this.finishPrefill(r, pool);
      return chunk;
    };

    if (c.decodePriority) {
      decodeUsed = runDecodes(total);
      prefillUsed = runPrefill(total - decodeUsed);
    } else {
      prefillUsed = runPrefill(total);
      decodeUsed = runDecodes(total - prefillUsed);
    }

    this.lastBudget[p] = { total, decode: decodeUsed, prefill: prefillUsed, unused: total - decodeUsed - prefillUsed };
    this.budgetEma = this.budgetEma * 0.95 + ((decodeUsed + prefillUsed) / total) * 0.05;

    for (const r of batch) {
      const phase = phases.get(r)!;
      const last = r.spans.at(-1);
      if (last?.phase === phase) last.end = this.now;
      else r.spans.push({ phase, start, end: this.now });
    }
  }

  /** Extend/create timeline spans for non-active holding phases (KV transfer stages). */
  private recordPhaseSpans(start: number, phases: Phase[]) {
    for (const r of this.requests) {
      if (!phases.includes(r.status)) continue;
      const last = r.spans.at(-1);
      if (last?.phase === r.status) last.end = this.now;
      else r.spans.push({ phase: r.status, start, end: this.now });
    }
  }

  private ensureKV(pool: KVCacheManager, r: Request, tokens: number) {
    const before = pool.evictions;
    pool.ensure(r, tokens, this.now);
    if (pool.evictions > before) {
      this.event('evict', `${pool.evictions - before} LRU prefix pages recycled`, r.id);
    }
  }

  private decodeDuration(r: Request, batchLen: number, kind: PoolKind) {
    const c = this.config;
    const tp = kind === 'prefill' ? c.prefillTP : kind === 'decode' ? c.decodeTP : c.tensorParallel;
    const speed = tp / (1 + 0.18 * (tp - 1));
    return (36 + contextTarget(r) / 128 + batchLen * 2) / Math.sqrt(speed)
      * (c.speculativeDecoding ? c.specCost : 1);
  }

  private emitToken(r: Request, pool: KVCacheManager) {
    const c = this.config;
    let tokens = 1;
    if (c.speculativeDecoding) {
      const drafted = Math.min(c.specDraftLength, r.outputTokens - r.generated);
      let accepted = 0;
      const pAccept = MetricsCollector.acceptanceProbability(c.specAcceptance);
      while (accepted < drafted && this.rng() < pAccept) accepted++;
      tokens = Math.min(accepted + 1, r.outputTokens - r.generated);
      r.speculative = { drafted, accepted, rejected: drafted - accepted };
      this.collector.drafted += drafted;
      this.collector.accepted += accepted;
      this.event('verify', `${accepted}/${drafted} draft tokens accepted; ${tokens} committed`, r.id);
    }
    tokens = Math.min(tokens, r.outputTokens - r.generated);
    this.ensureKV(pool, r, contextTarget(r) + tokens);
    this.collector.emit(r, tokens, this.now);
    r.generated += tokens;
    if (r.generated === r.outputTokens) this.completeRequest(r, pool);
  }

  private completeRequest(r: Request, pool: KVCacheManager) {
    r.status = 'completed';
    r.finishedAt = this.now;
    r.reason = 'Output complete';
    pool.release(r, this.config.prefixCaching, this.now);
    r.group = null;
    const ttftOk = r.firstTokenAt !== undefined && r.firstTokenAt - r.arrivedAt <= r.sloTTFT;
    const tpotOk = r.generated <= 1 ? true
      : (r.lastTokenAt! - r.firstTokenAt!) / (r.generated - 1) <= r.sloTPOT;
    this.collector.complete(r, this.now, ttftOk && tpotOk);
    this.collector.record(r, this.now);
    this.event('complete', `${r.generated} tokens in ${this.now - r.arrivedAt} ms; pages released`, r.id);
  }

  private finishPrefill(r: Request, pool: KVCacheManager) {
    const c = this.config;
    r.prefillDoneAt = this.now;
    if (r.resumeTarget !== null) {
      const recomputed = Math.max(0, r.resumeTarget - r.cachedTokens);
      r.recomputedTokens += recomputed;
      this.collector.recomputedTokens += recomputed;
      this.event('prefill', `recompute complete; ${recomputed} tokens recomputed`, r.id);
      r.resumeTarget = null;
    }
    if (c.servingMode === 'disaggregated') {
      r.status = 'transfer_wait';
      r.reason = 'Awaiting KV transfer to decode pool';
      this.event('prefill', `prefill complete on prefill pool ${r.prefillGroup}; staging KV transfer`, r.id);
      this.stageTransfer(r);
    } else {
      if (c.prefixCaching) pool.publish(r);
      r.status = 'decode';
      this.event('prefill', `Prefill complete; ${r.processed - r.cachedTokens} tokens computed`, r.id);
    }
  }

  // ---------- disaggregated KV transfer ----------

  private stageTransfer(r: Request) {
    const c = this.config;
    if (r.transfer || r.prefillGroup === null) return;
    const decodePools = this.pools.map((_, i) => i).filter(i => this.poolKinds[i] === 'decode');
    // Requests already staged (queued/in flight) also load the decode pool.
    const load = (i: number) => this.requests.filter(x =>
      x.decodeGroup === i && holding(x)).length;
    decodePools.sort((a, b) => load(a) - load(b) || a - b);
    for (const i of decodePools) {
      const pool = this.pools[i];
      const required = blocksFor(reservedTokens(r, 'decode'), c.blockSize);
      const reservation = pool.pinned + this.poolDebt(i);
      if (reservation + required <= this.usable(i)) {
        r.decodeGroup = i;
        const bytes = r.promptTokens * bytesPerToken(c);
        const rec = this.transfers.enqueue(r.id, `prefill:${r.prefillGroup}`, `decode:${i}`, bytes, this.now);
        r.transfer = { id: rec.id, bytes, queuedAt: this.now };
        r.reason = 'KV transfer queued';
        this.event('transfer-queue', `${(bytes / 1048576).toFixed(1)} MiB KV -> decode pool ${i}`, r.id);
        return;
      }
    }
    this.waitEvent(r, 'Decode pool KV pressure');
  }

  private startTransfer(rec: TransferRecord) {
    const r = this.requests.find(x => x.id === rec.requestId);
    if (!r || terminal(r)) return;
    r.status = 'transferring';
    if (r.transfer) r.transfer.startedAt = rec.startedAt;
    this.event('transfer-start', `${(rec.bytes / 1048576).toFixed(1)} MiB in flight`, r.id);
  }

  private completeTransfer(rec: TransferRecord) {
    const r = this.requests.find(x => x.id === rec.requestId);
    if (!r || terminal(r) || (r.status !== 'transfer_wait' && r.status !== 'transferring')) return;
    if (r.prefillGroup !== null) {
      this.pools[r.prefillGroup].release(r, this.config.prefixCaching, this.now);
    }
    r.blockTable = []; // drop prefill-pool page ids; the decode pool allocates fresh ones
    const dest = Number(rec.destination.split(':')[1]);
    const pool = this.pools[dest];
    const tokens = contextTarget(r);
    pool.allocateFresh(r, blocksFor(tokens, this.config.blockSize), tokens, this.now);
    r.group = dest;
    r.status = 'decode_wait';
    r.reason = `KV resident on decode pool ${dest}; awaiting decode admission`;
    if (r.transfer) r.transfer.finishedAt = rec.finishedAt;
    this.event('transfer-complete', `${(rec.bytes / 1048576).toFixed(1)} MiB arrived on decode pool ${dest}`, r.id);
  }

  // ---------- multi-tier restores ----------

  private completeRestore(rec: TransferRecord) {
    const r = this.requests.find(x => x.id === rec.requestId);
    const pending = this.pendingRestores.get(rec.requestId);
    this.pendingRestores.delete(rec.requestId);
    if (!r || terminal(r) || !pending) return;
    this.pools[pending.pool].restoreBlocks(pending.hashes, this.now);
    r.restore = null;
    r.tierHit = rec.source as 'cpu' | 'remote';
    r.reason = 'KV restored; awaiting admission';
    this.event('restore-complete', `${pending.hashes.length} blocks restored from ${rec.source} tier`, r.id);
  }

  // ---------- observability ----------

  private updateWorkers() {
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
    const poolCount = this.pools.length;
    const totalBlocks = poolCount * this.config.numBlocks;
    const occupied = this.pools.reduce((n, p) => n + p.occupied, 0);
    const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const bothWorkers = this.workers.filter(w => w.kind === 'both');
    const prefillWorkers = this.workers.filter(w => w.kind === 'prefill');
    const decodeWorkers = this.workers.filter(w => w.kind === 'decode');
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
      tokenBudgetUtilization: this.budgetEma * 100,
      schedulerIterations: this.iterations,
      networkBytes: this.transfers.bytesTotal,
      transfersActive: this.transfers.active.length,
      transfersQueued: this.transfers.queue.length,
      transfersCompleted: this.transfers.completed,
      restores: this.restores.completed,
      tierBytesMoved: this.pools.reduce((n, p) => n + p.demoteBytes + p.restoreBytes, 0),
    };
  }

  // ---------- correctness ----------

  /** Index of the pool where a request currently holds KV blocks (null = none). */
  private ownerPoolOf(r: Request): number | null {
    if (terminal(r) || r.status === 'preempted' || r.status === 'waiting') return null;
    if (this.config.servingMode === 'monolithic') return r.group;
    return r.status === 'decode' || r.status === 'decode_wait' ? r.decodeGroup : r.prefillGroup;
  }

  /** Requests whose KV blocks live on pool p. */
  private poolBlockOwners(p: number): Request[] {
    return this.requests.filter(r => this.ownerPoolOf(r) === p);
  }

  assertInvariants() {
    const c = this.config;
    const bs = c.blockSize;
    const byId = new Map(this.requests.map(r => [r.id, r] as const));
    for (let p = 0; p < this.pools.length; p++) {
      const pool = this.pools[p];
      const usage = this.lastBudget[p];
      if (usage.decode + usage.prefill > usage.total || usage.total > c.maxNumBatchedTokens) {
        throw new Error('Token budget exceeded');
      }
    }
    // Per-request checks against the pool that actually holds its blocks.
    for (const r of this.requests) {
      if (new Set(r.blockTable).size !== r.blockTable.length) throw new Error('Duplicate page');
      if (r.generated > r.outputTokens) throw new Error('Output overflow');
      if (r.processed > contextTarget(r)) throw new Error('Prefill overflow');
      if (r.resumeTarget !== null && r.processed > r.resumeTarget) throw new Error('Recompute overflow');
      const poolIdx = this.ownerPoolOf(r);
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
    // Per-pool capacity, debt and ownership cross-references.
    for (let p = 0; p < this.pools.length; p++) {
      const pool = this.pools[p];
      const kind = this.poolKinds[p];
      let debt = 0;
      for (const r of this.poolRequests(p)) debt += this.debtOnPool(r, p);
      if (pool.pinned > pool.capacity) throw new Error('Overallocated KV pool');
      if (pool.pinned + debt > pool.capacity) throw new Error('Overcommitted KV');
      const ownerIds = new Set(this.poolBlockOwners(p).map(r => r.id));
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
    // Cheap non-finite guards on core counters (percentile-heavy metrics getter avoided here).
    const finite = (v: number) => Number.isFinite(v);
    if (!finite(this.collector.outputTokens) || this.collector.outputTokens < 0) throw new Error('Bad output counter');
    if (!finite(this.now) || this.now < 0) throw new Error('Bad clock');
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
