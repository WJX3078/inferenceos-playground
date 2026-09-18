import { blockChain, KVCacheManager, tokenIdentity } from './cache';
import { MetricsCollector } from './metrics';
import { effectivePriority, scheduleTokens } from './scheduler';
import { batchCost, stageSlice } from './communication';
import { active, finiteInt, normalizeConfig, STEP_MS } from './types';
import type { Config, Iteration, Metrics, Request, RequestInput, Sample, SchedulerEvent, SchedulerStats, TPStats, Worker } from './types';

export class SimulationEngine {
  readonly config: Config;
  now = 0;
  requests: Request[] = [];
  pools: KVCacheManager[];
  workers: Worker[];
  events: SchedulerEvent[] = [];
  samples: Sample[] = [];
  iterations: Iteration[] = [];
  readonly schedulerStats: SchedulerStats = { iterations: 0, prefillTokens: 0, decodeTokens: 0, mixedIterations: 0, usedTokens: 0, availableTokens: 0 };
  readonly preemptionStats = { count: 0, recomputedTokens: 0, overheadMs: 0 };
  readonly tpStats: TPStats = { computeMs: 0, communicationMs: 0, collectiveBytes: 0 };
  readonly occupancyIntegral = { gpu: 0, kv: 0 };
  readonly inFlight: ({ snapshot: Iteration; elapsed: number; speculative: boolean } | null)[] = [];
  readonly collector = new MetricsCollector();
  private serial = 0;
  private eventSerial = 0;
  private seed: number;
  private readonly verificationSeed: number;
  private readonly schedulingCursors: { decode: number; prefill: number }[];
  private arrivals: { at: number; input: RequestInput }[] = [];

  constructor(config: Partial<Config> = {}, seed = 73) {
    this.config = normalizeConfig(config);
    this.seed = seed >>> 0;
    this.verificationSeed = seed >>> 0;
    this.pools = Array.from({ length: this.config.gpuCount / this.config.tensorParallel },
      () => new KVCacheManager(this.config.numBlocks, this.config.blockSize));
    this.inFlight = this.pools.map(() => null);
    this.schedulingCursors = this.pools.map(() => ({ decode: 0, prefill: 0 }));
    this.workers = Array.from({ length: this.config.gpuCount }, (_, id) => ({
      id, group: Math.floor(id / this.config.tensorParallel), rank: id % this.config.tensorParallel,
      requestIds: [], utilization: 0, phase: 'idle',
    }));
  }
  private random() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  private acceptsDraft(r: Request, position: number) {
    // Common random numbers per request/output position, independent of scheduling order.
    let value = this.verificationSeed ^ Math.imul(Number(r.id.slice(1)), 0x9e3779b9) ^ Math.imul(position + 1, 0x85ebca6b);
    value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
    value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967296 < 0.76;
  }
  private event(type: string, message: string, requestId?: string) {
    this.events.unshift({ id: ++this.eventSerial, at: this.now, type, message, requestId });
    this.events.length = Math.min(100, this.events.length);
  }
  enqueue(input: RequestInput): Request {
    const promptTokens = finiteInt(input.promptTokens, 1, 8192);
    const prefix = ['chat', 'code', 'docs'].includes(input.prefix) ? input.prefix : 'none';
    const tokenIds = tokenIdentity(promptTokens, prefix, this.serial + 1, input.tokenIds);
    const prefixChain = blockChain(tokenIds, this.config.blockSize);
    const r: Request = {
      ...input, promptTokens, prefix, outputTokens: finiteInt(input.outputTokens, 1, 1024),
      tokenIds, prefixChain, prefixLookup: [],
      id: `R${String(++this.serial).padStart(3, '0')}`, arrivedAt: this.now,
      priority: input.priority === 'LOW' || input.priority === 'HIGH' ? input.priority : 'NORMAL',
      waitingSince: this.now, queueMs: 0, preemptions: 0, recomputing: false, recomputeUntil: 0, recomputeLostUntil: 0, recomputedTokens: 0, resumedAt: this.now,
      status: 'waiting', group: null, processed: 0, generated: 0, cachedTokens: 0,
      prefixTokens: prefixChain.length * this.config.blockSize,
      blockTable: [], compute: 0, reason: 'Awaiting scheduler', spans: [], speculative: null,
    };
    this.requests.push(r);
    if (Math.ceil((r.promptTokens + r.outputTokens) / this.config.blockSize) > this.config.numBlocks) {
      r.status = 'rejected'; r.finishedAt = this.now;
      r.reason = 'Context exceeds one replica KV pool';
      this.collector.rejected++;
      this.event('reject', r.reason, r.id);
    } else if (this.requests.filter(x => x.status === 'waiting').length > 256) {
      r.status = 'rejected'; r.finishedAt = this.now; r.reason = 'Queue limit: 256';
      this.collector.rejected++;
      this.event('reject', r.reason, r.id);
    } else this.event('arrival', `${promptTokens} prompt / ${r.outputTokens} output tokens`, r.id);
    return r;
  }
  burst(count: number, input: RequestInput) {
    return Array.from({ length: finiteInt(count, 1, 64) }, () => this.enqueue({
      ...input, promptTokens: Math.max(1, Math.round(input.promptTokens * (0.5 + this.random()))),
      outputTokens: Math.max(1, Math.round(input.outputTokens * (0.5 + this.random()))),
    }));
  }
  schedule(input: RequestInput, at: number) {
    this.arrivals.push({ input, at: Math.max(this.now, Math.ceil(at / STEP_MS) * STEP_MS) });
    this.arrivals.sort((a, b) => a.at - b.at);
  }
  get pendingArrivals() { return this.arrivals.length; }
  cancel(id: string) {
    const r = this.requests.find(x => x.id === id);
    if (!r || (!active(r) && r.status !== 'waiting')) return;
    if (r.group !== null) this.pools[r.group].release(r, this.config.prefixCaching, this.now);
    r.status = 'cancelled'; r.finishedAt = this.now; r.reason = 'Cancelled by operator';
    this.collector.cancelled++;
    this.event('cancel', 'Pages released', id);
    this.updateWorkers();
  }
  setFeatures(features: Partial<Pick<Config, 'continuousBatching' | 'prefixCaching' | 'speculativeDecoding'>>) {
    Object.assign(this.config, features);
    if (!this.config.prefixCaching) this.pools.forEach(p => p.clearUnused());
    this.event('config', 'Scheduler feature flags updated');
  }
  private debt(r: Request) {
    return Math.ceil((r.promptTokens + r.outputTokens) / this.config.blockSize) - r.blockTable.length;
  }
  private candidates(r: Request, excluded = new Set<string>()) {
    return this.pools.map((pool, group) => {
      const batch = this.requests.filter(x => x.group === group && active(x) && !excluded.has(x.id));
      const cached = this.config.prefixCaching && !r.recomputing ? pool.match(r) : [];
      const pinnedIds = new Set(pool.blocks.filter(b => b.owners.some(id => !excluded.has(id))).map(b => b.id));
      const newlyPinned = cached.filter(id => !pinnedIds.has(id)).length;
      const required = Math.ceil((r.promptTokens + r.outputTokens) / this.config.blockSize);
      const reservation = pinnedIds.size + batch.reduce((n, x) => n + this.debt(x), 0);
      const fits = reservation + newlyPinned + required - cached.length <= pool.capacity;
      const staticBusy = !!this.inFlight[group] || (!this.config.continuousBatching && batch.some(x => x.resumedAt !== this.now));
      return { pool, group, batch, cached, fits, staticBusy };
    }).sort((a, b) => a.batch.length - b.batch.length || b.cached.length - a.cached.length);
  }
  private preemptFor(r: Request) {
    if (!this.config.preemption || this.config.schedulerPolicy !== 'priority') return false;
    const victims = this.requests.filter(v => active(v) && effectivePriority(v, this.now) < effectivePriority(r, this.now)
      && !this.inFlight[v.group!]
      && v.preemptions < 3 && this.now - v.resumedAt >= 200)
      .sort((a, b) => effectivePriority(a, this.now) - effectivePriority(b, this.now) || b.blockTable.length - a.blockTable.length);
    for (let group = 0; group < this.pools.length; group++) {
      const excluded = new Set<string>();
      for (const victim of victims.filter(v => v.group === group)) {
        excluded.add(victim.id);
        const feasible = this.candidates(r, excluded).find(c => c.group === group && c.fits && !c.staticBusy && c.batch.length < this.config.maxNumSeqs);
        if (!feasible) continue;
        // Commit only after the full reservation/slot check succeeds.
        for (const id of excluded) {
          const v = this.requests.find(v => v.id === id)!;
          v.recomputeLostUntil = Math.max(v.recomputeLostUntil, v.status === 'prefill' ? v.processed : v.promptTokens + v.generated);
          this.pools[group].release(v, this.config.prefixCaching, this.now);
          v.blockTable = []; v.group = null; v.status = 'waiting';
          v.recomputeUntil = v.promptTokens + v.generated;
          v.processed = 0; v.cachedTokens = 0; v.compute = 0;
          v.recomputing = true; v.preemptions++; v.preemptedAt = this.now; v.waitingSince = this.now;
          v.reason = `PREEMPTED → waiting for RECOMPUTE; ${r.id} has higher effective priority`;
          v.spans.push({ phase: 'preempted', start: this.now, end: this.now + STEP_MS });
          this.preemptionStats.count++;
          this.event('preempt', v.reason, v.id);
        }
        return true;
      }
    }
    return false;
  }
  private admit() {
    const waiting = this.requests.filter(x => x.status === 'waiting').sort((a, b) =>
      (this.config.schedulerPolicy === 'priority' ? effectivePriority(b, this.now) - effectivePriority(a, this.now) : 0) || a.waitingSince - b.waitingSince);
    for (const r of waiting) {
      let candidates = this.candidates(r);
      let target = candidates.find(x => x.fits && !x.staticBusy && x.batch.length < this.config.maxNumSeqs);
      if (!target && this.preemptFor(r)) {
        candidates = this.candidates(r);
        target = candidates.find(x => x.fits && !x.staticBusy && x.batch.length < this.config.maxNumSeqs);
      }
      if (!target) {
        const reason = candidates.every(x => !x.fits) ? 'KV reservation pressure'
          : candidates.some(x => this.inFlight[x.group]) ? 'Replica iteration in flight'
            : candidates.some(x => x.staticBusy) ? 'Static cohort draining' : 'Batch slots occupied';
        if (r.reason !== reason) this.event('wait', reason, r.id);
        r.reason = reason;
        continue;
      }
      r.group = target.group;
      this.collector.admit(r, this.now);
      r.admittedAt ??= this.now;
      r.resumedAt = this.now;
      r.status = 'prefill';
      r.reason = r.recomputing ? `RECOMPUTE ${r.recomputeUntil} context tokens` : `Admitted to replica ${target.group}`;
      target.pool.attach(r, target.cached, this.now);
      r.cachedTokens = target.cached.length * this.config.blockSize;
      r.processed = r.cachedTokens;
      r.prefixLookup = r.prefixChain.map((b, i) => ({ ...b, hit: i < target.cached.length, page: target.cached[i] ?? null }));
      if (this.config.prefixCaching && r.prefixTokens && !r.recomputing) {
        this.collector.lookups++;
        if (r.cachedTokens) this.collector.hits++;
      }
      this.collector.cachedTokens += r.cachedTokens;
      this.event('admit', `Replica ${r.group}; ${r.cachedTokens} cached tokens`, r.id);
      if (r.cachedTokens) this.event('prefix', `Reused ${target.cached.length} immutable prefix pages`, r.id);
      if (r.processed === (r.recomputing ? r.recomputeUntil : r.promptTokens)) r.status = 'decode';
    }
  }
  step(count = 1) {
    for (let tick = 0; tick < finiteInt(count, 1, 10000); tick++) {
      const start = this.now;
      while (this.arrivals[0]?.at <= this.now) this.enqueue(this.arrivals.shift()!.input);
      this.admit();
      // Admission occurs at the interval start; allocation/release commits at its end.
      this.updateWorkers();
      const intervalMetrics = this.metrics;
      this.occupancyIntegral.gpu += intervalMetrics.gpuUtilization * STEP_MS;
      this.occupancyIntegral.kv += intervalMetrics.kvUtilization * STEP_MS;
      this.now += STEP_MS;
      for (let group = 0; group < this.pools.length; group++) {
        const batch = this.requests.filter(r => active(r) && r.group === group);
        const pool = this.pools[group];
        if (!this.inFlight[group]) {
        const plan = scheduleTokens(batch, this.config, this.schedulingCursors[group], new Set(batch.map(r => r.id)));
        this.schedulingCursors[group] = plan.nextCursor;
        const prefillTokens = plan.scheduled.filter(a => a.phase === 'prefill').reduce((n, a) => n + a.tokens, 0);
        const decodeTokens = plan.scheduled.filter(a => a.phase === 'decode').reduce((n, a) => n + a.tokens, 0);
        const snapshot: Iteration = {
          iteration: this.now / STEP_MS, group, at: start, budget: this.config.maxNumBatchedTokens,
          used: prefillTokens + decodeTokens, prefillTokens, decodeTokens, remaining: plan.remaining,
          scheduled: plan.scheduled, skipped: [...plan.skipped, ...this.requests.filter(r => r.status === 'waiting').map(r => ({ requestId: r.id, reason: r.reason, priority: r.priority }))],
          pinned: pool.pinned, reserved: pool.pinned + batch.reduce((n, r) => n + this.debt(r), 0), capacity: pool.capacity,
          slots: batch.length, maxSlots: this.config.maxNumSeqs,
        };
        const decoding = plan.scheduled.filter(a => a.phase === 'decode');
        snapshot.cost = batchCost(this.config, prefillTokens, decoding.length,
          Math.max(0, ...decoding.map(a => {
            const r = batch.find(r => r.id === a.requestId)!;
            return r.promptTokens + r.generated;
          })), this.config.speculativeDecoding, decodeTokens);
        this.iterations.push(snapshot);
        if (this.iterations.length > 240) this.iterations.shift();
        this.schedulerStats.iterations++;
        this.schedulerStats.prefillTokens += prefillTokens;
        this.schedulerStats.decodeTokens += decodeTokens;
        this.schedulerStats.usedTokens += snapshot.used;
        this.schedulerStats.availableTokens += snapshot.budget;
        if (prefillTokens && decodeTokens) this.schedulerStats.mixedIterations++;
        this.inFlight[group] = { snapshot, elapsed: 0, speculative: this.config.speculativeDecoding };
        }
        const flight = this.inFlight[group]!;
        const cost = flight.snapshot.cost!;
        const slice = stageSlice(cost, flight.elapsed, Math.min(cost.totalMs, flight.elapsed + STEP_MS));
        this.tpStats.computeMs += slice.computeMs;
        this.tpStats.communicationMs += slice.communicationMs;
        this.tpStats.collectiveBytes += cost.communicationMs ? cost.collectiveBytes * slice.communicationMs / cost.communicationMs : 0;
        flight.elapsed += STEP_MS;
        if (flight.elapsed + 1e-9 < cost.totalMs) continue;
        const snapshot = flight.snapshot;
        for (const allocation of snapshot.scheduled) {
          const r = this.requests.find(r => r.id === allocation.requestId);
          if (!r || !active(r) || r.group !== group) continue;
          const phase = allocation.phase;
          const recomputing = r.recomputing;
          const repeated = recomputing && phase === 'prefill' ? Math.min(allocation.tokens, Math.max(0, r.recomputeLostUntil - r.processed)) : 0;
          const oldEvictions = pool.evictions;
          if (phase === 'prefill') {
            r.processed += allocation.tokens;
            pool.ensure(r, r.processed, this.now);
            if (recomputing) {
              r.recomputedTokens += repeated;
              this.preemptionStats.recomputedTokens += repeated;
              this.preemptionStats.overheadMs += cost.totalMs * repeated / allocation.tokens;
            }
            if (r.processed === (recomputing ? r.recomputeUntil : r.promptTokens)) {
              if (this.config.prefixCaching) pool.publish(r);
              r.recomputing = false;
              r.processed = r.promptTokens;
              r.status = 'decode';
              r.reason = 'RUNNING / decode';
              this.event('prefill', `Prefill complete; ${r.processed - r.cachedTokens} tokens computed`, r.id);
            }
          } else {
              let tokens = 1;
              if (flight.speculative && allocation.tokens > 1) {
                const drafted = allocation.tokens - 1;
                let accepted = 0;
                while (accepted < drafted && this.acceptsDraft(r, r.generated + accepted)) accepted++;
                tokens = Math.min(accepted + 1, r.outputTokens - r.generated);
                r.speculative = { drafted, accepted, rejected: drafted - accepted };
                this.collector.drafted += drafted; this.collector.accepted += accepted;
                this.event('verify', `${accepted}/${drafted} draft tokens accepted; ${tokens} committed`, r.id);
              }
              tokens = Math.min(tokens, allocation.tokens, r.outputTokens - r.generated);
              pool.ensure(r, r.promptTokens + r.generated + tokens, this.now);
              this.collector.emit(r, tokens, this.now);
              r.generated += tokens;
              if (r.generated === r.outputTokens) {
                r.status = 'completed'; r.finishedAt = this.now; r.reason = 'Output complete';
                pool.release(r, this.config.prefixCaching, this.now);
                this.collector.complete(this.now);
                this.event('complete', `${r.generated} tokens; pages released`, r.id);
              }
          }
          if (pool.evictions > oldEvictions) this.event('evict', `${pool.evictions - oldEvictions} LRU prefix pages recycled`, r.id);
          r.spans.push({ phase: repeated ? 'recompute' : phase, start: snapshot.at, end: this.now, tokens: allocation.tokens, iteration: snapshot.iteration });
          if (r.spans.length > 600) r.spans.shift();
        }
        this.inFlight[group] = null;
      }
      this.updateWorkers();
      const m = this.metrics;
      if (this.now % 100 === 0) {
        this.samples.push({ at: this.now, tokens: m.tokensPerSecond, gpu: m.gpuUtilization, kv: m.kvUtilization });
        if (this.samples.length > 180) this.samples.shift();
      }
      // Bound display history independently from lifetime counters.
      const terminal = this.requests.filter(r => !active(r) && r.status !== 'waiting');
      const drop = new Set(terminal.slice(0, Math.max(0, terminal.length - 160)).map(r => r.id));
      if (drop.size) this.requests = this.requests.filter(r => !drop.has(r.id));
    }
  }
  private updateWorkers() {
    for (const w of this.workers) {
      const batch = this.requests.filter(r => active(r) && r.group === w.group);
      w.requestIds = batch.map(r => r.id);
      const prefill = batch.some(r => r.status === 'prefill');
      const decode = batch.some(r => r.status === 'decode');
      w.phase = prefill && decode ? 'mixed' : prefill ? 'prefill' : decode ? 'decode' : 'idle';
      w.utilization = batch.length ? Math.min(99, (prefill ? 48 : 25) + batch.length / this.config.maxBatchSize * 48) : 0;
    }
  }
  get metrics(): Metrics {
    return {
      ...this.collector.read(this.now),
      active: this.requests.filter(active).length,
      waiting: this.requests.filter(r => r.status === 'waiting').length,
      kvUtilization: this.pools.reduce((n, p) => n + p.occupied, 0) / (this.pools.length * this.config.numBlocks) * 100,
      gpuUtilization: this.workers.reduce((n, w) => n + w.utilization, 0) / this.workers.length,
      evictions: this.pools.reduce((n, p) => n + p.evictions, 0),
    };
  }
  assertInvariants() {
    const checkedIdentities = new Map<readonly number[], readonly string[]>();
    for (const r of this.requests) {
      if ([r.processed, r.generated, r.recomputedTokens, r.queueMs, r.preemptions].some(n => !Number.isFinite(n) || n < 0)) throw new Error('Invalid request counter');
      if (r.generated < 0 || r.generated > r.outputTokens || r.recomputedTokens < 0) throw new Error('Request accounting overflow');
      if (r.status === 'completed' && r.generated !== r.outputTokens) throw new Error('Incomplete terminal request');
      if (r.recomputing && r.processed > r.recomputeUntil) throw new Error('Recompute overflow');
      if (r.status === 'waiting' && r.preemptions && (r.blockTable.length || r.group !== null)) throw new Error('Preempted KV leak');
    }
    for (const s of this.iterations.slice(-this.pools.length)) {
      if (s.used > s.budget || s.used !== s.prefillTokens + s.decodeTokens || s.remaining < 0 || s.used + s.remaining !== s.budget) throw new Error('Token budget overflow');
      if (s.slots > s.maxSlots) throw new Error('Batch slot overflow');
    }
    for (let group = 0; group < this.pools.length; group++) {
      const pool = this.pools[group];
      const batch = this.requests.filter(r => active(r) && r.group === group);
      const ranks = this.workers.filter(w => w.group === group);
      if (ranks.some(w => w.requestIds.join(',') !== ranks[0].requestIds.join(',') || w.phase !== ranks[0].phase)) throw new Error('TP ranks diverged');
      if (pool.pinned + batch.reduce((n, r) => n + this.debt(r), 0) > pool.capacity) throw new Error('Overcommitted KV');
      for (const r of batch) {
        if (new Set(r.blockTable).size !== r.blockTable.length) throw new Error('Duplicate page');
        if (r.generated > r.outputTokens) throw new Error('Output overflow');
        for (const id of r.blockTable) if (!pool.blocks[id].owners.includes(r.id)) throw new Error('Missing page owner');
        for (let i = 0; i < r.prefixChain.length; i++) {
          const b = r.prefixChain[i];
          if (b.parentHash !== (i ? r.prefixChain[i - 1].hash : 'root')) throw new Error('Broken hash chain');
          const page = pool.blocks[r.blockTable[i]];
          if (page?.key && !pool.matches(page, r, i)) throw new Error('Invalid prefix sharing');
        }
      }
      for (const b of pool.blocks) {
        if (!Number.isInteger(b.used) || b.used < 0 || b.used > pool.blockSize) throw new Error('Block overflow');
        if (new Set(b.owners).size !== b.owners.length) throw new Error('Duplicate owner');
        for (const id of b.owners) if (!batch.some(r => r.id === id && r.blockTable.includes(b.id))) throw new Error('Leaked owner');
        if (b.owners.length > 1 && !b.key) throw new Error('Mutable shared page');
        if (b.key && (b.used !== pool.blockSize || b.logicalIndex === null || b.identity === null)) throw new Error('Invalid immutable page');
        if (b.key && b.logicalIndex !== null && b.identity) {
          let hashes = checkedIdentities.get(b.identity);
          if (!hashes) { hashes = blockChain(b.identity, pool.blockSize).map(b => b.hash); checkedIdentities.set(b.identity, hashes); }
          if (b.key !== hashes[b.logicalIndex]) throw new Error('Invalid cache hash');
        }
      }
    }
  }
}
