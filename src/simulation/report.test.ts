import { expect, it } from 'vitest';
import { Comparison } from './comparison';
import { buildWorkload } from './workload';
import { experimentReport, explainMetric, markdownReport } from './report';
import { createScenario, SCENARIOS } from './scenarios';

it('exports real workload, metric deltas and all subsystem stats', () => {
  const trace = buildWorkload({ count: 8, longContextRatio: 0, outputMin: 4, outputMax: 8 });
  const lab = new Comparison(trace);
  while (!lab.done) lab.step(20);
  const report = experimentReport(lab, 'continuous');
  expect(report.workload).toEqual(trace);
  expect(report.experiments).toHaveLength(4);
  expect(report.experiments[1].delta.ttft).toBe(0);
  expect(report.experiments[0].schedulerStats.usedTokens).toBeGreaterThan(0);
  expect(report.experiments[0].tpStats.computeMs).toBeGreaterThan(0);
  expect(report.experiments[2].cacheStats.lookups).toBeGreaterThan(0);
  expect(report.assumptions.join(' ')).toContain('synthetic');
  expect(markdownReport(report)).toContain('Continuous');
  expect(explainMetric(lab.experiments[2], lab.experiments[0], 'ttft')).toEqual(explainMetric(lab.experiments[2], lab.experiments[0], 'ttft'));
  expect(explainMetric(lab.experiments[2], lab.experiments[0], 'ttft').join(' ')).toContain(lab.experiments[2].metrics.cachedTokens.toString());
});

it('provides 15 scenarios that expose chunking, priority and preemption', () => {
  expect(SCENARIOS).toHaveLength(15);
  const chunked = createScenario('chunked');
  chunked.step(10);
  expect(chunked.schedulerStats.mixedIterations).toBeGreaterThan(0);
  const preempt = createScenario('preemption');
  preempt.step(100);
  expect(preempt.preemptionStats.count).toBeGreaterThan(0);
  expect(preempt.preemptionStats.recomputedTokens).toBeGreaterThan(0);
});

it('restarts a lesson with edited configuration without losing its planned arrivals', () => {
  const engine = createScenario('preemption', { maxNumBatchedTokens: 16 }, { promptTokens: 64, outputTokens: 96, prefix: 'none', priority: 'LOW' });
  expect(engine.config.maxNumBatchedTokens).toBe(16);
  expect(engine.requests[0].promptTokens).toBe(64);
  expect(engine.pendingArrivals).toBe(2);
  engine.step(180);
  expect(engine.preemptionStats.count).toBeGreaterThan(0);
  expect(engine.requests.map(r => r.arrivedAt)).toEqual([0, 400, 800]);
});
