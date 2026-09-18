import { describe, expect, it } from 'vitest';
import { buildWorkload, DEFAULT_WORKLOAD, fingerprint } from './workload';
import { Comparison, delta } from './comparison';

describe('immutable workload replay', () => {
  it('materializes all six patterns deterministically, in arrival order', () => {
    for (const pattern of ['uniform', 'burst', 'poisson', 'prefix-heavy', 'long-context', 'mixed'] as const) {
      const trace = buildWorkload({ ...DEFAULT_WORKLOAD, pattern, count: 32 });
      expect(trace).toEqual(buildWorkload({ ...DEFAULT_WORKLOAD, pattern, count: 32 }));
      expect(Object.isFrozen(trace)).toBe(true);
      expect(trace.every(Object.isFrozen)).toBe(true);
      expect(trace.every((r, i) => r.arrival % 20 === 0 && (!i || r.arrival >= trace[i - 1].arrival))).toBe(true);
      expect(new Set(trace.map(r => r.id)).size).toBe(32);
    }
  });
  it('changes token lengths with seed and validates empty or invalid builder input', () => {
    expect(fingerprint(buildWorkload({ seed: 1 }))).not.toBe(fingerprint(buildWorkload({ seed: 2 })));
    const trace = buildWorkload({ count: NaN, promptMin: -5, promptMax: Infinity, outputMin: -2 });
    expect(trace).toHaveLength(1);
    expect(trace[0].promptTokens).toBeGreaterThan(0);
    expect(trace[0].outputTokens).toBeGreaterThan(0);
  });
});

describe('Comparison', () => {
  it('feeds the exact same immutable trace to all strategies with exact arrivals', () => {
    const trace = buildWorkload({ count: 12, intervalMs: 60, promptMin: 64, promptMax: 128, outputMin: 4, outputMax: 16 });
    const lab = new Comparison(trace, { gpuCount: 1 }, 19);
    while (!lab.done) lab.step(25);
    expect(lab.experiments).toHaveLength(4);
    for (const run of lab.experiments) {
      expect(run.trace).toBe(trace);
      expect(run.engine.requests.map(r => [r.id, r.arrivedAt, r.promptTokens, r.outputTokens, r.prefix]))
        .toEqual(trace.map(r => [r.id, r.arrival, r.promptTokens, r.outputTokens, r.prefix]));
      expect(run.metrics.completed).toBe(trace.length);
      expect(run.metrics.tokensPerSecond).toBeCloseTo(trace.reduce((n, r) => n + r.outputTokens, 0) / (run.finishedAt! / 1000));
      expect(run.metrics.requestsPerSecond).toBeCloseTo(trace.length / (run.finishedAt! / 1000));
      run.engine.assertInvariants();
    }
    lab.assertInvariants();
  });
  it('is deterministic and retains final metrics while slower strategies drain', () => {
    const trace = buildWorkload({ count: 8, intervalMs: 0, outputMin: 3, outputMax: 8 });
    const a = new Comparison(trace), b = new Comparison(trace);
    while (!a.done) a.step(20);
    while (!b.done) b.step(7);
    expect(a.experiments.map(r => r.metrics)).toEqual(b.experiments.map(r => r.metrics));
    const metrics = a.experiments.map(r => ({ ...r.metrics }));
    a.step(100);
    expect(a.experiments.map(r => r.metrics)).toEqual(metrics);
  });
  it('uses explicit undefined deltas for zero/missing baselines', () => {
    expect(delta(150, 100)).toBe(50);
    expect(delta(60, 100)).toBe(-40);
    expect(delta(10, 0)).toBeNull();
    expect(delta(10, null)).toBeNull();
    expect(delta(null, 10)).toBeNull();
    expect(delta(0, 10)).toBe(-100);
  });
});
