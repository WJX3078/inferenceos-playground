import type { Request } from './types';

export class MetricsCollector {
  completed = 0;
  rejected = 0;
  cancelled = 0;
  outputTokens = 0;
  cachedTokens = 0;
  lookups = 0;
  hits = 0;
  drafted = 0;
  accepted = 0;
  private ttftSum = 0;
  private firstTokens = 0;
  private intervalSum = 0;
  private intervals = 0;
  private window: { at: number; tokens: number; completed: number }[] = [];

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
    this.window.push({ at: now, tokens: count, completed: 0 });
  }
  complete(now: number) {
    this.completed++;
    this.window.push({ at: now, tokens: 0, completed: 1 });
  }
  read(now: number) {
    this.window = this.window.filter(x => now - x.at < 1000);
    const seconds = Math.max(0.02, Math.min(1, now / 1000));
    return {
      ttft: this.firstTokens ? this.ttftSum / this.firstTokens : null,
      tpot: this.intervals ? this.intervalSum / this.intervals : null,
      tokensPerSecond: this.window.reduce((sum, x) => sum + x.tokens, 0) / seconds,
      requestsPerSecond: this.window.reduce((sum, x) => sum + x.completed, 0) / seconds,
      prefixHitRate: this.lookups ? this.hits / this.lookups * 100 : 0,
      completed: this.completed, rejected: this.rejected, cancelled: this.cancelled,
      outputTokens: this.outputTokens, cachedTokens: this.cachedTokens,
      drafted: this.drafted, accepted: this.accepted,
    };
  }
}
