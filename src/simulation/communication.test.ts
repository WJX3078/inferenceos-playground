import { describe, expect, it } from 'vitest';
import { batchCost } from './communication';
import { normalizeConfig } from './types';
import { Comparison, tpStrategies } from './comparison';
import { buildWorkload } from './workload';

describe('communication-aware tensor parallelism', () => {
  it('has no collectives on TP1 and conserves the four stage durations', () => {
    const cost = batchCost(normalizeConfig({ gpuCount: 1 }), 512, 2, 256, false);
    expect(cost.communicationMs).toBe(0);
    expect(cost.collectiveBytes).toBe(0);
    expect(cost.stages.map(s => s.name)).toEqual(['Attention projection', 'AllReduce', 'MLP', 'AllReduce']);
    expect(cost.stages.reduce((n, s) => n + s.ms, 0)).toBeCloseTo(cost.totalMs);
  });
  it('reduces compute but increases collective volume and latency with TP degree', () => {
    const costs = [1, 2, 4, 8].map(tp => batchCost(normalizeConfig({ gpuCount: tp, tensorParallel: tp }), 512, 2, 256, false));
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i].computeMs).toBeLessThan(costs[i - 1].computeMs);
      expect(costs[i].collectiveBytes).toBeGreaterThan(costs[i - 1].collectiveBytes);
    }
    const pcie = batchCost(normalizeConfig({ gpuCount: 8, tensorParallel: 8, interconnect: 'pcie' }), 512, 2, 256, false);
    expect(pcie.communicationMs).toBeGreaterThan(costs[3].communicationMs);
  });
  it('makes a slow interconnect delay actual completion; TP can be slower than TP1', () => {
    const trace = buildWorkload({ count: 4, promptMin: 64, promptMax: 64, outputMin: 6, outputMax: 6, longContextRatio: 0 });
    const lab = new Comparison(trace, { interconnect: 'custom', bandwidthGBps: 1, latencyUs: 5000 }, 73, tpStrategies());
    while (!lab.done) lab.step(50);
    lab.assertInvariants();
    const [one, , , eight] = lab.experiments;
    expect(eight.finishedAt!).toBeGreaterThan(one.finishedAt!);
    expect(eight.engine.tpStats.communicationMs).toBeGreaterThan(0);
    expect(one.engine.tpStats.communicationMs).toBe(0);
    expect(eight.engine.workers[0].requestIds).toEqual(eight.engine.workers[7].requestIds);
    expect(lab.experiments.every(e => e.engine.pools.length === 1)).toBe(true);
  });
  it('keeps custom parameters finite and positive', () => {
    const cost = batchCost(normalizeConfig({ gpuCount: 8, tensorParallel: 8, interconnect: 'custom', bandwidthGBps: NaN, latencyUs: Infinity }), 100, 1, 20, true);
    expect(Number.isFinite(cost.totalMs)).toBe(true);
    expect(cost.totalMs).toBeGreaterThan(0);
  });
});
