// Metrics: lifetime counters, per-request observations, tail percentiles,
// SLO accounting and goodput. All values derive from the deterministic
// simulation clock; nothing samples the wall clock.

import type { Priority, Request } from './types.ts';

export interface RequestObservation {
  id: string;
  priority: Priority;
  status: 'completed' | 'cancelled' | 'rejected';
  arrivedAt: number;
  finishedAt: number;
  queueLatency: number;          // arrival -> first admission into a pool
  prefillLatency: number | null; // first admission -> prefill (or recompute) complete
  decodeLatency: number | null;  // first token -> last token
  ttft: number | null;           // arrival -> first emitted token
  tpot: number | null;           // per-request mean inter-token latency
  e2e: number;                   // arrival -> finish (partial for cancelled)
  promptTokens: number;
  outputTokens: number;
  generatedTokens: number;
  cachedTokens: number;
  preemptions: number;
  recomputedTokens: number;
  prefillQueueLatency: number | null;
  kvTransferQueueLatency: number | null;
  kvTransferLatency: number | null;
  decodeQueueLatency: number | null;
  meetsTTFTSLO: boolean | null;  // null for non-completed requests
  meetsTPOTSLO: boolean | null;
  meetsSLO: boolean | null;
}

/** Nearest-rank percentile: smallest value with cumulative rank >= ceil(p/100 * n). */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const ACCEPTANCE = { low: 0.25, medium: 0.7, high: 0.92 } as const;

export class MetricsCollector {
  completed = 0;
  rejected = 0;
  cancelled = 0;
  outputTokens = 0;
  cachedTokens = 0;
  lookups = 0;
  hits = 0;
  tierHitsGpu = 0;
  tierHitsCpu = 0;
  tierHitsRemote = 0;
  tierRecomputes = 0;
  drafted = 0;
  accepted = 0;
  preemptions = 0;
  recomputedTokens = 0;
  private ttftSum = 0;
  private firstTokens = 0;
  private intervalSum = 0;
  private intervals = 0;
  private window: { at: number; tokens: number; completed: number; good: number }[] = [];
  observations: RequestObservation[] = [];
  // Memoized percentiles, recomputed only when a new observation lands.
  private percentileCache: { key: string; value: Pick<import('./types.ts').Metrics,
    'ttftP50' | 'ttftP90' | 'ttftP95' | 'ttftP99' | 'tpotP50' | 'tpotP90' | 'tpotP95' | 'tpotP99' |
    'e2eP50' | 'e2eP95' | 'e2eP99'> } | null = null;

  static acceptanceProbability(profile: keyof typeof ACCEPTANCE) {
    return ACCEPTANCE[profile] ?? ACCEPTANCE.medium;
  }

  emit(r: Request, count: number, now: number) {
    if (r.firstTokenAt === undefined) {
      r.firstTokenAt = now;
      this.ttftSum += now - r.arrivedAt;
      this.firstTokens++;
      this.intervals += count - 1;
    } else {
      this.intervalSum += now - r.lastTokenAt!;
      this.intervals += count;
    }
    r.lastTokenAt = now;
    this.outputTokens += count;
    this.window.push({ at: now, tokens: count, completed: 0, good: 0 });
  }

  complete(r: Request, now: number, meetsSLO: boolean) {
    this.completed++;
    this.window.push({ at: now, tokens: 0, completed: 1, good: meetsSLO ? 1 : 0 });
  }

  /** Record the terminal observation for a request. Called exactly once per request. */
  record(r: Request, now: number) {
    const status = r.status as RequestObservation['status'];
    if (status !== 'completed' && status !== 'cancelled' && status !== 'rejected') return;
    const ttft = r.firstTokenAt === undefined ? null : r.firstTokenAt - r.arrivedAt;
    const tpot = r.generated > 1 && r.firstTokenAt !== undefined
      ? (r.lastTokenAt! - r.firstTokenAt) / (r.generated - 1)
      : null;
    const meetsTTFT = status === 'completed' ? ttft !== null && ttft <= r.sloTTFT : null;
    const meetsTPOT = status === 'completed' ? tpot !== null && tpot <= r.sloTPOT : null;
    // The full kv_transfer_wait phase: prefill completion -> transfer start.
    // Covers both decode-pool staging waits and the transfer queue itself.
    const transferStart = r.transfer?.startedAt ?? r.transfer?.finishedAt;
    const transferQueue = r.transfer && transferStart !== undefined && r.prefillDoneAt !== undefined
      ? transferStart - r.prefillDoneAt : null;
    const transferMove = r.transfer && r.transfer.startedAt !== undefined && r.transfer.finishedAt !== undefined
      ? r.transfer.finishedAt - r.transfer.startedAt : null;
    this.observations.push({
      id: r.id,
      priority: r.priority,
      status,
      arrivedAt: r.arrivedAt,
      finishedAt: r.finishedAt ?? now,
      queueLatency: (r.prefillAdmittedAt ?? r.admittedAt ?? r.arrivedAt) - r.arrivedAt,
      prefillLatency: r.prefillDoneAt === undefined ? null : r.prefillDoneAt - (r.prefillAdmittedAt ?? r.admittedAt ?? r.arrivedAt),
      decodeLatency: r.firstTokenAt === undefined || r.lastTokenAt === undefined ? null : r.lastTokenAt - r.firstTokenAt,
      ttft,
      tpot,
      e2e: (r.finishedAt ?? now) - r.arrivedAt,
      promptTokens: r.promptTokens,
      outputTokens: r.outputTokens,
      generatedTokens: r.generated,
      cachedTokens: r.cachedTokens,
      preemptions: r.preemptions,
      recomputedTokens: r.recomputedTokens,
      prefillQueueLatency: r.prefillAdmittedAt === undefined ? null : r.prefillAdmittedAt - r.arrivedAt,
      kvTransferQueueLatency: transferQueue,
      kvTransferLatency: transferMove,
      decodeQueueLatency: r.decodeAdmittedAt === undefined || r.transfer === null || r.transfer.finishedAt === undefined
        ? null : r.decodeAdmittedAt - r.transfer.finishedAt,
      meetsTTFTSLO: meetsTTFT,
      meetsTPOTSLO: meetsTPOT,
      meetsSLO: status === 'completed' ? meetsTTFT === true && meetsTPOT === true : null,
    });
    if (this.observations.length > 4000) this.observations.splice(0, this.observations.length - 4000);
    this.percentileCache = null;
  }

  private percentiles() {
    const key = `${this.observations.length}`;
    if (this.percentileCache && this.percentileCache.key === key) return this.percentileCache.value;
    const completed = this.observations.filter(o => o.status === 'completed');
    const ttfts = this.observations.filter(o => o.ttft !== null).map(o => o.ttft!).sort((a, b) => a - b);
    const tpots = this.observations.filter(o => o.tpot !== null).map(o => o.tpot!).sort((a, b) => a - b);
    const e2es = completed.map(o => o.e2e).sort((a, b) => a - b);
    const value = {
      ttftP50: percentile(ttfts, 50), ttftP90: percentile(ttfts, 90), ttftP95: percentile(ttfts, 95), ttftP99: percentile(ttfts, 99),
      tpotP50: percentile(tpots, 50), tpotP90: percentile(tpots, 90), tpotP95: percentile(tpots, 95), tpotP99: percentile(tpots, 99),
      e2eP50: percentile(e2es, 50), e2eP95: percentile(e2es, 95), e2eP99: percentile(e2es, 99),
    };
    this.percentileCache = { key, value };
    return value;
  }

  read(now: number) {
    this.window = this.window.filter(x => now - x.at < 1000);
    const seconds = Math.max(0.02, Math.min(1, now / 1000));
    const completed = this.observations.filter(o => o.status === 'completed');
    const sloMet = completed.filter(o => o.meetsSLO === true).length;
    const ttftMet = completed.filter(o => o.meetsTTFTSLO === true).length;
    const tpotMet = completed.filter(o => o.meetsTPOTSLO === true).length;
    const pct = this.percentiles();
    return {
      ttft: this.firstTokens ? this.ttftSum / this.firstTokens : null,
      tpot: this.intervals ? this.intervalSum / this.intervals : null,
      ...pct,
      tokensPerSecond: this.window.reduce((sum, x) => sum + x.tokens, 0) / seconds,
      requestsPerSecond: this.window.reduce((sum, x) => sum + x.completed, 0) / seconds,
      goodput: this.window.reduce((sum, x) => sum + x.good, 0) / seconds,
      sloAttainment: completed.length ? sloMet / completed.length * 100 : 0,
      ttftSloAttainment: completed.length ? ttftMet / completed.length * 100 : 0,
      tpotSloAttainment: completed.length ? tpotMet / completed.length * 100 : 0,
      prefixHitRate: this.lookups ? this.hits / this.lookups * 100 : 0,
      completed: this.completed, rejected: this.rejected, cancelled: this.cancelled,
      outputTokens: this.outputTokens, cachedTokens: this.cachedTokens,
      drafted: this.drafted, accepted: this.accepted,
      preemptions: this.preemptions, recomputedTokens: this.recomputedTokens,
      tierHitsGpu: this.tierHitsGpu, tierHitsCpu: this.tierHitsCpu,
      tierHitsRemote: this.tierHitsRemote, tierRecomputes: this.tierRecomputes,
    };
  }
}
