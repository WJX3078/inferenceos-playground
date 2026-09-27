// Per-pool execution: one scheduler iteration per replica per tick.
//
// Owns the token-budget accounting (decode slots vs one prefill chunk),
// chunked prefill, speculative draft/verify, KV growth, prefill completion,
// and the disaggregated KV flow (transfer staging / start / completion).
// Resource *policy* (which prefill sequence advances) comes from the
// scheduler; this module enforces the budget invariant.

import type { BudgetUsage, Config, Phase, PoolKind, Request } from '../types.ts';
import { STEP_MS, blocksFor, bytesPerToken, contextTarget, holding, terminal } from '../types.ts';
import { transitionRequest } from './lifecycle.ts';
import type { KVCacheManager } from '../cache.ts';
import { MetricsCollector } from '../metrics.ts';
import type { KVTransferManager, TransferRecord } from '../transfer.ts';
import type { Scheduler } from '../scheduler/types.ts';
import { poolDebt, usableCapacity } from './accounting.ts';

export interface ExecutorHost {
  config: Config;
  now: number;
  requests: Request[];
  pools: KVCacheManager[];
  poolKinds: PoolKind[];
  scheduler: Scheduler;
  collector: MetricsCollector;
  transfers: KVTransferManager;
  rng: () => number;
  lastBudget: BudgetUsage[];
  event: (type: string, message: string, requestId?: string) => void;
  ctx: () => { config: Config; now: number };
  releasePrefillBlocks: (r: Request) => void;
}

export class PoolExecutor {
  budgetEma = 0;
  private host: ExecutorHost;

  constructor(host: ExecutorHost) {
    this.host = host;
  }

  private poolTP(kind: PoolKind): number {
    const c = this.host.config;
    return kind === 'prefill' ? c.prefillTP : kind === 'decode' ? c.decodeTP : c.tensorParallel;
  }

  runIteration(p: number, start: number) {
    const host = this.host;
    const c = host.config;
    const pool = host.pools[p];
    const kind = host.poolKinds[p];
    const batch = host.requests.filter(r => r.group === p && (r.status === 'prefill' || r.status === 'decode'));
    const total = c.maxNumBatchedTokens;
    if (!batch.length) {
      host.lastBudget[p] = { total, decode: 0, prefill: 0, unused: total };
      this.budgetEma *= 0.95;
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
        used++; // each scheduled decode sequence consumes one budget slot
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
      const r = host.scheduler.pickPrefill(prefills, host.ctx());
      if (!r) return 0;
      const desired = Math.min(contextTarget(r) - r.processed, c.prefillChunkSize > 0 ? c.prefillChunkSize : Infinity);
      const chunk = Math.min(desired, avail);
      if (chunk <= 0) return 0;
      r.processed += chunk;
      this.ensureKV(pool, r, r.processed);
      if (c.prefillChunkSize > 0) {
        host.event('chunk', `prefill chunk ${chunk} tokens (${r.processed}/${contextTarget(r)})`, r.id);
        if (chunk < desired && decodeUsed > 0) {
          host.event('budget', `prefill truncated by token budget (${chunk}/${Math.round(desired)} tokens this iteration)`, r.id);
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

    host.lastBudget[p] = { total, decode: decodeUsed, prefill: prefillUsed, unused: total - decodeUsed - prefillUsed };
    this.budgetEma = this.budgetEma * 0.95 + ((decodeUsed + prefillUsed) / total) * 0.05;

    for (const r of batch) {
      const phase = phases.get(r)!;
      const last = r.spans.at(-1);
      if (last?.phase === phase) last.end = host.now;
      else r.spans.push({ phase, start, end: host.now });
    }
  }

  /** Extend/create timeline spans for non-active holding phases (KV transfer stages). */
  recordPhaseSpans(start: number, phases: Phase[]) {
    for (const r of this.host.requests) {
      if (!phases.includes(r.status)) continue;
      const last = r.spans.at(-1);
      if (last?.phase === r.status) last.end = this.host.now;
      else r.spans.push({ phase: r.status, start, end: this.host.now });
    }
  }

  private ensureKV(pool: KVCacheManager, r: Request, tokens: number) {
    const before = pool.evictions;
    pool.ensure(r, tokens, this.host.now);
    if (pool.evictions > before) {
      this.host.event('evict', `${pool.evictions - before} LRU prefix pages recycled`, r.id);
    }
  }

  private decodeDuration(r: Request, batchLen: number, kind: PoolKind) {
    const c = this.host.config;
    const tp = this.poolTP(kind);
    const speed = tp / (1 + 0.18 * (tp - 1));
    return (36 + contextTarget(r) / 128 + batchLen * 2) / Math.sqrt(speed)
      * (c.speculativeDecoding ? c.specCost : 1);
  }

  private emitToken(r: Request, pool: KVCacheManager) {
    const c = this.host.config;
    let tokens = 1;
    if (c.speculativeDecoding) {
      const drafted = Math.min(c.specDraftLength, r.outputTokens - r.generated);
      let accepted = 0;
      const pAccept = MetricsCollector.acceptanceProbability(c.specAcceptance);
      while (accepted < drafted && this.host.rng() < pAccept) accepted++;
      tokens = Math.min(accepted + 1, r.outputTokens - r.generated);
      r.speculative = { drafted, accepted, rejected: drafted - accepted };
      this.host.collector.drafted += drafted;
      this.host.collector.accepted += accepted;
      this.host.event('verify', `${accepted}/${drafted} draft tokens accepted; ${tokens} committed`, r.id);
    }
    tokens = Math.min(tokens, r.outputTokens - r.generated);
    this.ensureKV(pool, r, contextTarget(r) + tokens);
    this.host.collector.emit(r, tokens, this.host.now);
    r.generated += tokens;
    if (r.generated === r.outputTokens) this.completeRequest(r, pool);
  }

  private completeRequest(r: Request, pool: KVCacheManager) {
    const c = this.host.config;
    pool.release(r, c.prefixCaching, this.host.now);
    r.group = null;
    transitionRequest(r, 'completed', 'output complete');
    r.finishedAt = this.host.now;
    r.reason = 'Output complete';
    const ttftOk = r.firstTokenAt !== undefined && r.firstTokenAt - r.arrivedAt <= r.sloTTFT;
    const tpotOk = r.generated <= 1 ? true
      : (r.lastTokenAt! - r.firstTokenAt!) / (r.generated - 1) <= r.sloTPOT;
    this.host.collector.complete(r, this.host.now, ttftOk && tpotOk);
    this.host.collector.record(r, this.host.now);
    this.host.event('complete', `${r.generated} tokens in ${this.host.now - r.arrivedAt} ms; pages released`, r.id);
  }

  private finishPrefill(r: Request, pool: KVCacheManager) {
    const c = this.host.config;
    r.prefillDoneAt = this.host.now;
    if (r.resumeTarget !== null) {
      const recomputed = Math.max(0, r.resumeTarget - r.cachedTokens);
      r.recomputedTokens += recomputed;
      this.host.collector.recomputedTokens += recomputed;
      this.host.event('prefill', `recompute complete; ${recomputed} tokens recomputed`, r.id);
      r.resumeTarget = null;
    }
    if (c.servingMode === 'disaggregated') {
      transitionRequest(r, 'transfer_wait', 'prefill complete (disaggregated)');
      r.reason = 'Awaiting KV transfer to decode pool';
      this.host.event('prefill', `prefill complete on prefill pool ${r.prefillGroup}; staging KV transfer`, r.id);
      this.stageTransfer(r);
    } else {
      if (c.prefixCaching) pool.publish(r);
      transitionRequest(r, 'decode', 'prefill complete (monolithic)');
      this.host.event('prefill', `Prefill complete; ${r.processed - r.cachedTokens} tokens computed`, r.id);
    }
  }

  // ---------- disaggregated KV flow ----------

  stageTransfer(r: Request) {
    const c = this.host.config;
    if (r.transfer || r.prefillGroup === null) return;
    const decodePools = this.host.pools.map((_, i) => i).filter(i => this.host.poolKinds[i] === 'decode');
    const load = (i: number) => this.host.requests.filter(x =>
      x.decodeGroup === i && holding(x)).length;
    decodePools.sort((a, b) => load(a) - load(b) || a - b);
    for (const i of decodePools) {
      const pool = this.host.pools[i];
      const required = blocksFor(r.promptTokens + r.outputTokens, c.blockSize);
      const reservation = pool.pinned
        + poolDebt(c, this.host.requests, this.host.poolKinds, i);
      if (reservation + required <= usableCapacity(c, pool)) {
        r.decodeGroup = i;
        const bytes = r.promptTokens * bytesPerToken(c);
        const priority = r.priority === 'high' ? 2 : r.priority === 'low' ? 0 : 1;
        const rec = this.host.transfers.enqueue(r.id, `prefill:${r.prefillGroup}`, `decode:${i}`, bytes,
          this.host.now, priority);
        r.transfer = { id: rec.id, bytes, queuedAt: this.host.now };
        r.reason = 'KV transfer queued';
        this.host.event('transfer-queue', `${(bytes / 1048576).toFixed(1)} MiB KV -> decode pool ${i}`, r.id);
        return;
      }
    }
    r.reason = 'Decode pool KV pressure';
    this.host.event('wait', 'Decode pool KV pressure', r.id);
  }

  startTransfer(rec: TransferRecord) {
    const r = this.host.requests.find(x => x.id === rec.requestId);
    if (!r || terminal(r)) return;
    transitionRequest(r, 'transferring', 'transfer started');
    if (r.transfer) r.transfer.startedAt = rec.startedAt;
    this.host.event('transfer-start', `${(rec.bytes / 1048576).toFixed(1)} MiB in flight`, r.id);
  }

  completeTransfer(rec: TransferRecord) {
    const r = this.host.requests.find(x => x.id === rec.requestId);
    if (!r || terminal(r) || (r.status !== 'transfer_wait' && r.status !== 'transferring')) return;
    this.host.releasePrefillBlocks(r);
    r.blockTable = []; // drop prefill-pool page ids; the decode pool allocates fresh ones
    const dest = Number(rec.destination.split(':')[1]);
    const pool = this.host.pools[dest];
    const tokens = contextTarget(r);
    pool.allocateFresh(r, blocksFor(tokens, this.host.config.blockSize), tokens, this.host.now);
    r.group = dest;
    transitionRequest(r, 'decode_wait', 'KV resident on decode pool');
    r.reason = `KV resident on decode pool ${dest}; awaiting decode admission`;
    if (r.transfer) r.transfer.finishedAt = rec.finishedAt;
    this.host.event('transfer-complete', `${(rec.bytes / 1048576).toFixed(1)} MiB arrived on decode pool ${dest}`, r.id);
  }
}
