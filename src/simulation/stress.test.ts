import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine';
import { createRng } from './rng';

// Randomized stress testing: deterministic seeds generate adversarial
// configurations (high load, KV pressure, cancellations, preemption, prefix
// sharing, disaggregation, spec decode, multi-tier KV) and the engine must
// survive tens of thousands of simulated ticks with invariants checked
// throughout. Failures here are bugs: never silence assertions.

interface StressCase {
  name: string;
  seed: number;
  config: Record<string, unknown>;
  requests: number;
  prompt: [number, number];
  output: [number, number];
  cancelEvery?: number;
  steps: number;
}

const CASES: StressCase[] = [
  { name: 'high load fcfs', seed: 11, config: { gpuCount: 2, maxBatchSize: 8, numBlocks: 64 }, requests: 40, prompt: [64, 1024], output: [8, 128], steps: 6000 },
  { name: 'kv pressure priority preemption', seed: 22, config: { gpuCount: 1, numBlocks: 32, maxBatchSize: 4, schedulerPolicy: 'priority', preemptionMode: 'recompute' }, requests: 24, prompt: [128, 512], output: [32, 128], cancelEvery: 137, steps: 8000 },
  { name: 'slo overload preemption', seed: 33, config: { gpuCount: 1, numBlocks: 48, maxBatchSize: 4, schedulerPolicy: 'slo', preemptionMode: 'recompute', sloTTFTms: 250 }, requests: 30, prompt: [128, 768], output: [16, 96], cancelEvery: 211, steps: 8000 },
  { name: 'sjf mixed with prefix reuse', seed: 44, config: { gpuCount: 2, schedulerPolicy: 'sjf', numBlocks: 96, maxBatchSize: 6, prefixCaching: true }, requests: 36, prompt: [64, 512], output: [8, 64], steps: 6000 },
  { name: 'spec decode stress', seed: 55, config: { gpuCount: 2, speculativeDecoding: true, specDraftLength: 16, specAcceptance: 'low', numBlocks: 64, maxBatchSize: 8 }, requests: 30, prompt: [64, 512], output: [16, 128], steps: 6000 },
  { name: 'disaggregated pressure', seed: 66, config: { servingMode: 'disaggregated', gpuCount: 4, prefillGpuCount: 2, decodeGpuCount: 2, numBlocks: 48, maxBatchSize: 6, kvTransferBandwidthGBps: 8 }, requests: 24, prompt: [256, 1024], output: [32, 96], cancelEvery: 173, steps: 8000 },
  { name: 'multi-tier thrash', seed: 77, config: { gpuCount: 1, numBlocks: 24, kvTiers: 'gpu-cpu-remote', cpuKvBlocks: 16, remoteKvBlocks: 32, maxBatchSize: 2 }, requests: 24, prompt: [128, 512], output: [16, 64], steps: 8000 },
  { name: 'chunked static mix', seed: 88, config: { gpuCount: 2, prefillChunkSize: 64, maxNumBatchedTokens: 48, decodePriority: false, continuousBatching: false, numBlocks: 64 }, requests: 24, prompt: [256, 1024], output: [8, 48], steps: 6000 },
  { name: 'watermark pressure', seed: 99, config: { gpuCount: 1, numBlocks: 48, kvWatermark: 0.2, maxBatchSize: 6 }, requests: 30, prompt: [128, 512], output: [32, 96], steps: 6000 },
];

describe('Randomized stress', () => {
  for (const tc of CASES) {
    it(`survives ${tc.name} (${tc.steps} ticks, seed ${tc.seed})`, () => {
      const rng = createRng(tc.seed);
      const e = new SimulationEngine(tc.config as never, tc.seed);
      const pick = ([lo, hi]: [number, number]) => Math.max(1, Math.round(lo + rng() * (hi - lo)));
      const families = ['chat', 'code', 'docs', 'none'];
      const priorities = ['low', 'normal', 'normal', 'high'] as const;
      for (let i = 0; i < tc.requests; i++) {
        // Stagger arrivals across the run so cancellations and preemption hit moving traffic.
        const promptTokens = pick(tc.prompt);
        e.enqueue({
          promptTokens,
          outputTokens: pick(tc.output),
          prefix: rng() < 0.5 ? families[Math.floor(rng() * families.length)] : 'none',
          priority: priorities[Math.floor(rng() * priorities.length)],
        });
        if (rng() < 0.5) e.step(Math.floor(rng() * 40));
      }
      let cancelled = 0;
      for (let i = 0; i < tc.steps; i++) {
        e.step();
        if (i % 25 === 0) e.assertInvariants();
        if (tc.cancelEvery && i % tc.cancelEvery === 0 && i > 0) {
          const victim = e.requests.find(r => r.status === 'prefill' || r.status === 'decode' || r.status === 'transfer_wait' || r.status === 'transferring');
          if (victim) { e.cancel(victim.id); cancelled++; }
        }
      }
      e.assertInvariants();
      const m = e.metrics;
      expect(m.completed + m.cancelled + m.rejected).toBeGreaterThanOrEqual(tc.requests - cancelled);
      expect(m.completed).toBeGreaterThan(0);
      // Output conservation: every emitted token belongs to a completed or
      // cancelled (partially decoded) request.
      const sum = (status: string) => e.collector.observations
        .filter(o => o.status === status)
        .reduce((n, o) => n + o.generatedTokens, 0);
      expect(m.outputTokens).toBe(sum('completed') + sum('cancelled'));
      expect(Number.isFinite(m.ttft ?? 0)).toBe(true);
      expect(Number.isFinite(m.tpot ?? 0)).toBe(true);
      expect(m.kvUtilization).toBeGreaterThanOrEqual(0);
      expect(m.kvUtilization).toBeLessThanOrEqual(100);
    });
  }

  it('runs the aggregate stress suite for tens of thousands of ticks with a shared seed stream', () => {
    const rng = createRng(2024);
    const configs = [
      { gpuCount: 1, numBlocks: 32, maxBatchSize: 8 },
      { gpuCount: 2, numBlocks: 48, schedulerPolicy: 'sjf', preemptionMode: 'recompute' },
      { servingMode: 'disaggregated', gpuCount: 4, prefillGpuCount: 1, decodeGpuCount: 3, numBlocks: 48 },
    ] as const;
    let ticks = 0;
    for (let round = 0; round < 3; round++) {
      const e = new SimulationEngine(configs[round] as Record<string, unknown>, 700 + round);
      for (let i = 0; i < 30; i++) {
        e.enqueue({
          promptTokens: 32 + Math.floor(rng() * 1600),
          outputTokens: 4 + Math.floor(rng() * 200),
          prefix: rng() < 0.6 ? 'chat' : 'none',
          priority: rng() < 0.2 ? 'high' : 'normal',
        });
      }
      for (let i = 0; i < 4000; i++) { e.step(); ticks++; }
      e.assertInvariants();
      expect(e.metrics.completed).toBeGreaterThan(0);
    }
    expect(ticks).toBe(12000);
  });
});
