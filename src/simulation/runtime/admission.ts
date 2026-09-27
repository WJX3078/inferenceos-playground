// Admission controller.
//
// Owns the decision "which queued request enters which pool, when". Policies
// order the queue (via the engine's aging-aware ordering); this module owns
// feasibility: conservative KV reservations, the KV watermark, batch slots,
// static-cohort gating, multi-tier restore scheduling and P/D backpressure.
//
// The host is the engine itself (structural subset): every field is read
// through the engine reference, so live config replacement is always visible.

import type { Config, PoolKind, Request } from '../types.ts';
import { active, blocksFor, bytesPerToken, contextTarget, reservedTokens } from '../types.ts';
import { transitionRequest } from './lifecycle.ts';
import type { KVCacheManager } from '../cache.ts';
import type { MetricsCollector } from '../metrics.ts';
import type { PreemptionController } from './preemption.ts';
import type { SchedulingContext, Scheduler } from '../scheduler/types.ts';

export interface AdmissionHost {
  config: Config;
  now: number;
  requests: Request[];
  pools: KVCacheManager[];
  poolKinds: PoolKind[];
  scheduler: Scheduler;
  collector: MetricsCollector;
  restores: {
    enqueue: (requestId: string, source: string, destination: string, bytes: number, now: number,
      priority?: number, bandwidthGBps?: number, fixedLatencyMs?: number) => unknown;
  };
  pendingRestores: Map<string, { pool: number; hashes: string[] }>;
  event: (type: string, message: string, requestId?: string) => void;
  waitEvent: (r: Request, reason: string) => void;
  ctx: () => SchedulingContext;
  usable: (p: number) => number;
  poolDebt: (p: number) => number;
  preemption: PreemptionController;
}

interface PoolCandidate {
  p: number;
  pool: KVCacheManager;
  kind: PoolKind;
  batch: Request[];
  cached: number[];
  fits: boolean;
  hardFits: boolean;
  staticBusy: boolean;
}

export class AdmissionController {
  backpressureActive = false;
  private host: AdmissionHost;

  constructor(host: AdmissionHost) {
    this.host = host;
  }

  private poolBatch(p: number, kind: PoolKind): Request[] {
    return this.host.requests.filter(x =>
      (kind === 'both' ? x.group === p : x.prefillGroup === p) && active(x));
  }

  admit() {
    const host = this.host;
    const c = host.config;
    if (c.servingMode === 'disaggregated') this.admitDecodePools();
    const queue = host.requests.filter(r => r.status === 'waiting' || r.status === 'preempted');
    if (!queue.length) { this.backpressureActive = false; return; }

    // P/D backpressure: when the decode pipeline is saturated, hold prefill
    // admission instead of producing un-transferable KV.
    if (c.servingMode === 'disaggregated' && c.maxPendingDecodeRequests > 0) {
      const pending = host.requests.filter(r =>
        r.status === 'transfer_wait' || r.status === 'transferring' || r.status === 'decode_wait').length;
      if (pending >= c.maxPendingDecodeRequests) {
        if (!this.backpressureActive) {
          this.backpressureActive = true;
          host.collector.backpressureEvents++;
          host.event('backpressure', `decode pipeline full (${pending} pending); prefill admission paused`);
        }
        host.collector.backpressureTicks++;
        for (const r of queue) host.waitEvent(r, 'Backpressure: decode pipeline full');
        return;
      }
      this.backpressureActive = false;
    }

    // Aging: requests waiting longer than starvationThresholdMs are admitted
    // before everything else (arrival order), whatever the policy says. FCFS
    // is unaffected (its order is arrival anyway).
    let ordered: Request[];
    if (c.starvationThresholdMs > 0) {
      const starving = queue.filter(r => host.now - r.arrivedAt >= c.starvationThresholdMs);
      const rest = queue.filter(r => host.now - r.arrivedAt < c.starvationThresholdMs);
      for (const r of starving) {
        if (r.starvedSince === null) {
          r.starvedSince = host.now;
          host.collector.starvationEvents++;
          host.event('starvation', `aged ${host.now - r.arrivedAt}ms in queue; promoted by starvation protection`, r.id);
        }
      }
      ordered = [...host.scheduler.order(starving, host.ctx()), ...host.scheduler.order(rest, host.ctx())];
    } else {
      ordered = host.scheduler.order(queue, host.ctx());
    }

    const poolIdx = host.pools.map((_, i) => i)
      .filter(i => c.servingMode === 'monolithic' || host.poolKinds[i] === 'prefill');
    // Work list: after a preemption the candidate is retried immediately (the
    // freed capacity is available now) and the victim is excluded from the
    // rest of this pass — otherwise victim and candidate could swap places
    // every tick (livelock).
    const work = [...ordered];
    const freshlyEvicted = new Set<string>();
    for (let wi = 0; wi < work.length; wi++) {
      const r = work[wi];
      if (freshlyEvicted.has(r.id)) continue;
      if (r.pendingRestoreCount > 0) continue; // waiting for tier restores to land
      const candidates = poolIdx.map(p => {
        const pool = host.pools[p];
        const kind = host.poolKinds[p];
        const batch = this.poolBatch(p, kind);
        const cached = c.prefixCaching && kind !== 'decode' ? pool.match(r) : [];
        const newlyPinned = cached.filter(id => !pool.blocks[id].owners.length).length;
        const required = blocksFor(reservedTokens(r, kind), c.blockSize);
        const total = pool.pinned + host.poolDebt(p) + newlyPinned + required - cached.length;
        const hardFits = total <= pool.capacity;
        return {
          p, pool, kind, batch, cached, hardFits,
          fits: hardFits && total <= host.usable(p),
          staticBusy: !c.continuousBatching && batch.some(x => x.admittedAt !== host.now),
        } satisfies PoolCandidate;
      }).sort((a, b) => a.batch.length - b.batch.length || b.cached.length - a.cached.length || a.p - b.p);
      const target = candidates.find(x => x.fits && !x.staticBusy && x.batch.length < c.maxBatchSize);
      if (!target) {
        const victim = host.preemption.tryPreempt(r, candidates);
        if (!victim) {
          const reason = !candidates.some(x => x.hardFits) ? 'KV reservation pressure'
            : !candidates.some(x => x.fits) ? `KV watermark reserve (${Math.round(c.kvWatermark * 100)}%)`
            : candidates.some(x => x.staticBusy) ? 'Static cohort draining' : 'Batch slots occupied';
          host.waitEvent(r, reason);
        } else {
          freshlyEvicted.add(victim.id);
          work.splice(wi + 1, 0, r); // retry the candidate now that capacity freed
        }
        continue;
      }
      if (c.prefixCaching && c.kvTiers !== 'gpu' && target.kind !== 'decode' && r.prefixTokens > 0) {
        if (this.scheduleTierRestores(r, target)) continue;
      }
      this.attachToPool(r, target);
    }
  }

  /** Queue block-granular restores for the missing prefix blocks. Returns true when restores are pending. */
  private scheduleTierRestores(r: Request, target: PoolCandidate): boolean {
    const c = this.host.config;
    const plan = target.pool.buildReusePlan(r);
    const blockBytes = c.blockSize * bytesPerToken(c);
    const bySource = (source: 'cpu' | 'remote') => plan.blocks.filter(b => b.source === source).map(b => b.hash);
    const cpuHashes = bySource('cpu');
    const remoteHashes = bySource('remote');
    this.host.collector.gpuHitBlocks += plan.blocks.filter(b => b.source === 'gpu').length;
    this.host.collector.recomputeBlocks += plan.blocks.filter(b => b.source === 'recompute').length;
    let pending = 0;
    const queueRestore = (tier: 'cpu' | 'remote', hashes: string[]) => {
      if (!hashes.length) return;
      if (tier === 'cpu') this.host.collector.cpuHitBlocks += hashes.length;
      else this.host.collector.remoteHitBlocks += hashes.length;
      const bandwidth = tier === 'cpu' ? c.cpuRestoreBandwidthGBps : c.remoteRestoreBandwidthGBps;
      const latency = tier === 'cpu' ? c.cpuRestoreLatencyMs : c.remoteRestoreLatencyMs;
      this.host.restores.enqueue(r.id, tier, `gpu:${target.p}`, hashes.length * blockBytes, this.host.now, 1, bandwidth, latency);
      this.host.pendingRestores.set(`${r.id}:${tier}`, { pool: target.p, hashes });
      pending++;
    };
    queueRestore('cpu', cpuHashes);
    queueRestore('remote', remoteHashes);
    if (pending > 0) {
      r.pendingRestoreCount = pending;
      const tiers = [cpuHashes.length && 'cpu', remoteHashes.length && 'remote'].filter(Boolean).join(' + ');
      r.reason = `Restoring ${cpuHashes.length + remoteHashes.length} KV blocks from ${tiers} tier`;
      this.host.event('restore-queue', r.reason, r.id);
      return true;
    }
    return false;
  }

  attachToPool(r: Request, t: {
    p: number; pool: KVCacheManager; kind: PoolKind; cached: number[];
  }) {
    const c = this.host.config;
    r.group = t.p;
    r.admittedAt = this.host.now;
    const resuming = r.status === 'preempted';
    if (t.kind !== 'decode') {
      r.prefillGroup = t.p;
      if (r.prefillAdmittedAt === undefined) r.prefillAdmittedAt = this.host.now;
    }
    if (resuming) {
      r.resumeTarget = contextTarget(r);
      this.host.event('resume', `re-admitted to pool ${t.p}; recompute ${contextTarget(r)} context tokens`, r.id);
    }
    t.pool.attach(r, t.cached, this.host.now);
    r.cachedTokens = t.cached.length * c.blockSize;
    r.processed = r.cachedTokens;
    transitionRequest(r, 'prefill', 'admitted');
    const kindLabel = t.kind === 'prefill' ? 'prefill pool' : t.kind === 'decode' ? 'decode pool' : 'replica';
    r.reason = `Admitted to ${kindLabel} ${t.p}`;
    if (c.prefixCaching && r.prefixTokens) {
      this.host.collector.lookups++;
      if (r.cachedTokens) this.host.collector.hits++;
    }
    this.host.collector.cachedTokens += r.cachedTokens;
    this.host.event('admit', `${kindLabel} ${t.p}; ${r.cachedTokens} cached tokens`, r.id);
    if (r.cachedTokens) this.host.event('prefix', `Reused ${t.cached.length} immutable prefix blocks`, r.id);
  }

  /** Disaggregated mode: admit decode_wait requests onto decode pools. */
  private admitDecodePools() {
    const c = this.host.config;
    for (let p = 0; p < this.host.pools.length; p++) {
      if (this.host.poolKinds[p] !== 'decode') continue;
      const candidates = this.host.requests.filter(r => r.decodeGroup === p && r.status === 'decode_wait');
      if (!candidates.length) continue;
      const ordered = this.host.scheduler.order(candidates, this.host.ctx());
      for (const r of ordered) {
        const batch = this.host.requests.filter(x => x.group === p && active(x));
        if (batch.length >= c.maxBatchSize) { this.host.waitEvent(r, 'Decode batch slots occupied'); break; }
        if (!c.continuousBatching && batch.some(x => x.admittedAt !== this.host.now)) {
          this.host.waitEvent(r, 'Static cohort draining');
          break;
        }
        transitionRequest(r, 'decode', 'decode pool admission');
        r.group = p;
        r.admittedAt = this.host.now;
        r.decodeAdmittedAt = this.host.now;
        r.reason = `Decoding on decode pool ${p}`;
        this.host.event('admit', `decode pool ${p}; ${r.blockTable.length} blocks resident`, r.id);
      }
    }
  }
}
