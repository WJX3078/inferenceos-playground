import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine';
import { Comparison } from './comparison';
import { buildWorkload } from './workload';
import { active } from './types';
import type { Config } from './types';

function drain(engine: SimulationEngine, limit = 8000) {
  for (let tick = 0; tick < limit && (engine.pendingArrivals || engine.metrics.active || engine.metrics.waiting); tick++) {
    engine.step();
    engine.assertInvariants();
  }
  expect(engine.pendingArrivals + engine.metrics.active + engine.metrics.waiting).toBe(0);
  expect(engine.pools.every(p => p.pinned === 0)).toBe(true);
  for (const value of [...Object.values(engine.metrics), ...Object.values(engine.tpStats), ...Object.values(engine.preemptionStats)]) {
    if (typeof value === 'number') expect(Number.isFinite(value) && value >= 0).toBe(true);
  }
}

describe('v0.2 seeded stress', () => {
  it('drains 96 combinations of topology, budgets, chunks, priority and cache features', () => {
    let seed = 917;
    const pick = <T,>(items: readonly T[]) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return items[Math.floor(seed / 4294967296 * items.length)];
    };
    for (let run = 0; run < 96; run++) {
      const gpuCount = pick([1, 2, 4, 8]);
      const config: Partial<Config> = {
        gpuCount, tensorParallel: pick([1, 2, 4, 8].filter(n => n <= gpuCount)),
        numBlocks: pick([16, 32, 64]), blockSize: pick([8, 16, 32, 64]),
        maxNumBatchedTokens: pick([1, 7, 32, 128, 2048]), maxNumSeqs: pick([1, 2, 4, 8]),
        maxPrefillTokensPerStep: pick([8, 32, 512]),
        continuousBatching: pick([true, false]), prefixCaching: pick([true, false]),
        speculativeDecoding: pick([true, false]), schedulerPolicy: pick(['fcfs', 'priority'] as const),
        preemption: true, interconnect: pick(['nvlink', 'pcie'] as const),
      };
      const engine = new SimulationEngine(config, run);
      const trace = buildWorkload({ seed: run, count: 12, promptMin: 16, promptMax: 192, outputMin: 1, outputMax: 20, longContextRatio: 0, intervalMs: 40 });
      trace.forEach(r => engine.schedule(r, r.arrival));
      drain(engine);
      expect(engine.metrics.completed + engine.metrics.rejected).toBe(trace.length);
      expect(engine.metrics.outputTokens).toBe(engine.requests.filter(r => r.status === 'completed').reduce((n, r) => n + r.outputTokens, 0));
      expect(engine.requests.filter(active)).toHaveLength(0);
    }
  }, 15000);

  it('keeps lifetime counters after 320 completions while bounding display history', () => {
    const engine = new SimulationEngine({ gpuCount: 2, maxPrefillTokensPerStep: 32, speculativeDecoding: true });
    for (let batch = 0; batch < 40; batch++) {
      for (let i = 0; i < 8; i++) engine.enqueue({ promptTokens: 32, outputTokens: 3, prefix: 'chat' });
      drain(engine);
    }
    expect(engine.metrics.completed).toBe(320);
    expect(engine.metrics.outputTokens).toBe(960);
    expect(engine.requests).toHaveLength(160);
    expect(engine.events.length).toBeLessThanOrEqual(100);
    expect(engine.iterations.length).toBeLessThanOrEqual(240);
    expect(engine.samples.length).toBeLessThanOrEqual(180);
    expect(engine.requests.every(r => r.spans.length <= 600)).toBe(true);
  });

  it('cancels in-flight collective work and toggles features without stale output or owners', () => {
    const engine = new SimulationEngine({ gpuCount: 4, tensorParallel: 4, interconnect: 'custom', bandwidthGBps: 1, latencyUs: 100, speculativeDecoding: true });
    const cancelled = engine.enqueue({ promptTokens: 128, outputTokens: 8, prefix: 'chat' });
    engine.step();
    expect(engine.inFlight[0]).not.toBeNull();
    engine.cancel(cancelled.id);
    const kept = engine.enqueue({ promptTokens: 128, outputTokens: 8, prefix: 'chat' });
    engine.setFeatures({ prefixCaching: false, speculativeDecoding: false, continuousBatching: false });
    drain(engine);
    expect(cancelled.generated).toBe(0);
    expect(kept.generated).toBe(8);
    expect(engine.metrics.outputTokens).toBe(8);
    expect(engine.pools[0].occupied).toBe(0);
  });
});

describe('fairness boundaries', () => {
  it('snapshots mutable external traces and token identities before replay', () => {
    const input = structuredClone(buildWorkload({ count: 2, longContextRatio: 0 })).map(r => ({ ...r, tokenIds: [...r.tokenIds!] }));
    const original = structuredClone(input);
    const lab = new Comparison(input);
    input[1].arrival += 2000;
    input[0].tokenIds[0] += 1;
    expect(lab.trace).toEqual(original);
    expect(Object.isFrozen(lab.trace)).toBe(true);
    expect(lab.trace.every(r => Object.isFrozen(r) && Object.isFrozen(r.tokenIds))).toBe(true);
    while (!lab.done) lab.step(50);
    lab.assertInvariants();
  });

  it('rejects trace values that would be silently normalized during replay', () => {
    const trace = buildWorkload({ count: 1, longContextRatio: 0 });
    for (const bad of [{ id: 'duplicate' }, { promptTokens: 0 }, { outputTokens: 1025 }, { prefix: 'invalid' }, { tokenIds: [NaN] }]) {
      expect(() => new Comparison([{ ...trace[0], ...bad }])).toThrow();
    }
  });

  it('does not let speculative decisions change the next generated traffic burst', () => {
    const a = new SimulationEngine({ speculativeDecoding: false }, 81);
    const b = new SimulationEngine({ speculativeDecoding: true }, 81);
    for (const engine of [a, b]) {
      engine.enqueue({ promptTokens: 64, outputTokens: 40, prefix: 'none' });
      drain(engine);
    }
    const input = { promptTokens: 128, outputTokens: 32, prefix: 'none' };
    expect(a.burst(8, input).map(r => [r.promptTokens, r.outputTokens]))
      .toEqual(b.burst(8, input).map(r => [r.promptTokens, r.outputTokens]));
  });
});
