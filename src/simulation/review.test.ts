import { expect, it } from 'vitest';
import { SimulationEngine } from './engine';
import { Comparison, STRATEGIES } from './comparison';
import { experimentReport } from './report';
import { buildWorkload } from './workload';

const drain = (e: SimulationEngine) => {
  for (let i = 0; i < 10000 && (e.metrics.active || e.metrics.waiting); i++) e.step();
  expect(e.metrics.active + e.metrics.waiting).toBe(0);
  e.assertInvariants();
};

it('rotates low-budget service independently of multi-tick duration and replenished slots', () => {
  const e = new SimulationEngine({ gpuCount: 1, numBlocks: 256, maxNumSeqs: 2, maxNumBatchedTokens: 1 });
  const input = { promptTokens: 16, outputTokens: 1, prefix: 'none', tokenIds: Array.from({ length: 16 }, (_, i) => i) };
  e.enqueue(input); drain(e);
  const older = e.enqueue({ ...input, outputTokens: 100 });
  for (let i = 0; i < 40; i++) {
    const next = e.enqueue(input);
    for (let tick = 0; tick < 10 && next.status !== 'completed'; tick++) e.step();
    expect(next.status).toBe('completed');
    e.assertInvariants();
  }
  expect(older.generated).toBeGreaterThanOrEqual(20);
});

it('charges actual truncated speculative positions and no draft overhead for one position', () => {
  const run = (speculativeDecoding: boolean) => {
    const e = new SimulationEngine({ gpuCount: 2, tensorParallel: 2, maxNumBatchedTokens: 1, prefixCaching: false,
      interconnect: 'custom', bandwidthGBps: 1, latencyUs: 0, speculativeDecoding });
    e.enqueue({ promptTokens: 1, outputTokens: 4, prefix: 'none' }); drain(e);
    return e;
  };
  const plain = run(false), spec = run(true);
  expect(spec.metrics.drafted).toBe(0);
  expect(spec.tpStats).toEqual(plain.tpStats);
  expect(spec.now).toBe(plain.now);
});

it('does not charge a skipped long prefill to an unchanged scheduled decode', () => {
  const cost = (long: boolean) => {
    const e = new SimulationEngine({ gpuCount: 1, numBlocks: 512, maxNumBatchedTokens: 1, prefixCaching: false });
    e.enqueue({ promptTokens: 1, outputTokens: 4, prefix: 'none' }); e.step();
    if (long) e.enqueue({ promptTokens: 4096, outputTokens: 1, prefix: 'none' });
    e.step();
    return e.iterations.at(-1)!.cost;
  };
  expect(cost(true)).toEqual(cost(false));
});

it('counts only previously materialized prefill positions as recompute overhead', () => {
  const e = new SimulationEngine({ gpuCount: 1, maxNumSeqs: 1, numBlocks: 512, maxPrefillTokensPerStep: 32,
    prefixCaching: false, schedulerPolicy: 'priority', preemption: true });
  const low = e.enqueue({ promptTokens: 1024, outputTokens: 1, prefix: 'none', priority: 'LOW' });
  e.step(10);
  const lost = low.processed;
  e.enqueue({ promptTokens: 1, outputTokens: 1, prefix: 'none', priority: 'HIGH' });
  drain(e);
  expect(lost).toBe(320);
  expect(low.recomputedTokens).toBe(lost);
  expect(e.preemptionStats.recomputedTokens).toBe(lost);
  expect(e.preemptionStats.overheadMs).toBeCloseTo(lost * 0.03);
});

it('retains earlier lost context through a second preemption during reconstruction', () => {
  const e = new SimulationEngine({ gpuCount: 1, maxNumSeqs: 1, numBlocks: 512, maxPrefillTokensPerStep: 32,
    prefixCaching: false, schedulerPolicy: 'priority', preemption: true });
  const low = e.enqueue({ promptTokens: 1024, outputTokens: 1, prefix: 'none', priority: 'LOW' });
  const high = { promptTokens: 1, outputTokens: 1, prefix: 'none', priority: 'HIGH' as const };
  e.schedule(high, 400); e.schedule(high, 660);
  drain(e);
  expect(low.preemptions).toBe(2);
  const prefillWork = low.spans.filter(s => s.phase === 'prefill' || s.phase === 'recompute').reduce((n, s) => n + s.tokens!, 0);
  expect(prefillWork - low.promptTokens).toBe(960);
  expect(low.recomputedTokens).toBe(prefillWork - low.promptTokens);
  expect(e.preemptionStats.recomputedTokens).toBe(low.recomputedTokens);
  expect(e.preemptionStats.overheadMs).toBeCloseTo(960 * 0.03);
});

it('integrates admitted execution occupancy and KV lifetime before completion transitions', () => {
  const lab = new Comparison([{ id: 'R001', arrival: 0, promptTokens: 16, outputTokens: 1, prefix: 'chat' }], {},
    73, [{ ...STRATEGIES[0], config: { gpuCount: 1, maxNumSeqs: 1, prefixCaching: true } }]);
  while (!lab.done) lab.step();
  const run = lab.experiments[0];
  expect(run.finishedAt).toBe(60);
  expect(run.metrics.gpuUtilization).toBeCloseTo((96 * 20 + 73 * 40) / 60);
  expect(run.metrics.kvUtilization).toBeCloseTo(100 / 512 * 40 / 60);
});

it('captures report snapshots independently of subsequent engine progress', () => {
  const lab = new Comparison(buildWorkload({ count: 2 }));
  const report = experimentReport(lab, 'static'), before = JSON.stringify(report);
  lab.step(10);
  expect(JSON.stringify(report)).toBe(before);
});

it('recognizes successful completion on the exact experiment cutoff', () => {
  const lab = new Comparison([{ id: 'R001', arrival: 119940, promptTokens: 1, outputTokens: 1, prefix: 'none' }], { gpuCount: 1 }, 73, [STRATEGIES[0]]);
  while (!lab.done) lab.step(1000);
  expect(lab.experiments[0].finishedAt).toBe(120000);
  expect(lab.timedOut).toBe(false);
  expect(experimentReport(lab, 'static').status).toBe('complete');
});
