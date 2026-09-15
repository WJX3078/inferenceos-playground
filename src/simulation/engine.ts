import { KVCacheManager } from './cache';
import { MetricsCollector } from './metrics';
import { active, finiteInt, normalizeConfig, STEP_MS } from './types';
import type { Config, Metrics, Request, RequestInput, Sample, SchedulerEvent, Worker } from './types';

export class SimulationEngine {
  readonly config: Config;
  now = 0;
  requests: Request[] = [];
  pools: KVCacheManager[];
  workers: Worker[];
  events: SchedulerEvent[] = [];
  samples: Sample[] = [];
  readonly collector = new MetricsCollector();
  private serial = 0;
  private eventSerial = 0;
  private seed: number;

  constructor(config: Partial<Config> = {}, seed = 73) {
    this.config = normalizeConfig(config);
    this.seed = seed >>> 0;
    this.pools = Array.from({ length: this.config.gpuCount / this.config.tensorParallel },
      () => new KVCacheManager(this.config.numBlocks, this.config.blockSize));
    this.workers = Array.from({ length: this.config.gpuCount }, (_, id) => ({
      id, group: Math.floor(id / this.config.tensorParallel), rank: id % this.config.tensorParallel,
      requestIds: [], utilization: 0, phase: 'idle',
    }));
  }
  private random() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  private event(type: string, message: string, requestId?: string) {
    this.events.unshift({ id: ++this.eventSerial, at: this.now, type, message, requestId });
    this.events.length = Math.min(100, this.events.length);
  }
  enqueue(input: RequestInput): Request {
    const promptTokens = finiteInt(input.promptTokens, 1, 8192);
    const prefix = ['chat', 'code', 'docs'].includes(input.prefix) ? input.prefix : 'none';
    const r: Request = {
      ...input, promptTokens, prefix, outputTokens: finiteInt(input.outputTokens, 1, 1024),
      id: `R${String(++this.serial).padStart(3, '0')}`, arrivedAt: this.now,
      status: 'waiting', group: null, processed: 0, generated: 0, cachedTokens: 0,
      prefixTokens: prefix === 'none' ? 0 : Math.min(128, Math.floor(promptTokens / 2 / this.config.blockSize) * this.config.blockSize),
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
  private admit() {
    for (const r of this.requests.filter(x => x.status === 'waiting')) {
      const candidates = this.pools.map((pool, group) => {
        const batch = this.requests.filter(x => x.group === group && active(x));
        const cached = this.config.prefixCaching ? pool.match(r) : [];
        const newlyPinned = cached.filter(id => !pool.blocks[id].owners.length).length;
        const required = Math.ceil((r.promptTokens + r.outputTokens) / this.config.blockSize);
        const reservation = pool.pinned + batch.reduce((n, x) => n + this.debt(x), 0);
        const fits = reservation + newlyPinned + required - cached.length <= pool.capacity;
        const staticBusy = !this.config.continuousBatching && batch.some(x => x.admittedAt !== this.now);
        return { pool, group, batch, cached, fits, staticBusy };
      }).sort((a, b) => a.batch.length - b.batch.length || b.cached.length - a.cached.length);
      const target = candidates.find(x => x.fits && !x.staticBusy && x.batch.length < this.config.maxBatchSize);
      if (!target) {
        const reason = candidates.every(x => !x.fits) ? 'KV reservation pressure'
          : candidates.some(x => x.staticBusy) ? 'Static cohort draining' : 'Batch slots occupied';
        if (r.reason !== reason) this.event('wait', reason, r.id);
        r.reason = reason;
        continue;
      }
      r.group = target.group;
      r.admittedAt = this.now;
      r.status = 'prefill';
      r.reason = `Admitted to replica ${target.group}`;
      target.pool.attach(r, target.cached, this.now);
      r.cachedTokens = target.cached.length * this.config.blockSize;
      r.processed = r.cachedTokens;
      if (this.config.prefixCaching && r.prefixTokens) {
        this.collector.lookups++;
        if (r.cachedTokens) this.collector.hits++;
      }
      this.collector.cachedTokens += r.cachedTokens;
      this.event('admit', `Replica ${r.group}; ${r.cachedTokens} cached tokens`, r.id);
      if (r.cachedTokens) this.event('prefix', `Reused ${target.cached.length} immutable prefix pages`, r.id);
    }
  }
  step(count = 1) {
    for (let tick = 0; tick < finiteInt(count, 1, 10000); tick++) {
      const start = this.now;
      this.admit();
      this.now += STEP_MS;
      for (let group = 0; group < this.pools.length; group++) {
        const batch = this.requests.filter(r => active(r) && r.group === group);
        const pool = this.pools[group];
        const speed = this.config.tensorParallel / (1 + 0.18 * (this.config.tensorParallel - 1));
        for (const r of batch) {
          const phase = r.status;
          const oldEvictions = pool.evictions;
          if (phase === 'prefill') {
            const chunk = Math.max(1, Math.floor(32 * speed / Math.sqrt(batch.length)));
            r.processed = Math.min(r.promptTokens, r.processed + chunk);
            pool.ensure(r, r.processed, this.now);
            if (r.processed === r.promptTokens) {
              if (this.config.prefixCaching) pool.publish(r);
              r.status = 'decode';
              this.event('prefill', `Prefill complete; ${r.processed - r.cachedTokens} tokens computed`, r.id);
            }
          } else {
            r.compute += STEP_MS;
            const duration = (36 + r.promptTokens / 128 + batch.length * 2) / Math.sqrt(speed)
              * (this.config.speculativeDecoding ? 1.65 : 1);
            if (r.compute >= duration) {
              r.compute -= duration;
              let tokens = 1;
              if (this.config.speculativeDecoding) {
                const drafted = Math.min(4, r.outputTokens - r.generated);
                let accepted = 0;
                while (accepted < drafted && this.random() < 0.76) accepted++;
                tokens = Math.min(accepted + 1, r.outputTokens - r.generated);
                r.speculative = { drafted, accepted, rejected: drafted - accepted };
                this.collector.drafted += drafted; this.collector.accepted += accepted;
                this.event('verify', `${accepted}/${drafted} draft tokens accepted; ${tokens} committed`, r.id);
              }
              tokens = Math.min(tokens, r.outputTokens - r.generated);
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
          }
          if (pool.evictions > oldEvictions) this.event('evict', `${pool.evictions - oldEvictions} LRU prefix pages recycled`, r.id);
          const last = r.spans.at(-1);
          if (last?.phase === phase) last.end = this.now;
          else r.spans.push({ phase, start, end: this.now });
        }
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
    for (let group = 0; group < this.pools.length; group++) {
      const pool = this.pools[group];
      const batch = this.requests.filter(r => active(r) && r.group === group);
      if (pool.pinned + batch.reduce((n, r) => n + this.debt(r), 0) > pool.capacity) throw new Error('Overcommitted KV');
      for (const r of batch) {
        if (new Set(r.blockTable).size !== r.blockTable.length) throw new Error('Duplicate page');
        if (r.generated > r.outputTokens) throw new Error('Output overflow');
        for (const id of r.blockTable) if (!pool.blocks[id].owners.includes(r.id)) throw new Error('Missing page owner');
      }
      for (const b of pool.blocks) {
        if (b.used > pool.blockSize) throw new Error('Block overflow');
        for (const id of b.owners) if (!batch.some(r => r.id === id && r.blockTable.includes(b.id))) throw new Error('Leaked owner');
        if (b.owners.length > 1 && !b.key) throw new Error('Mutable shared page');
      }
    }
  }
}
