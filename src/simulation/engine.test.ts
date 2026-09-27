import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine';
import { createScenario, SCENARIOS } from './scenarios';
import type { Request } from './types';

const input = { promptTokens: 64, outputTokens: 12, prefix: 'none' };
const IN_FLIGHT = ['waiting', 'prefill', 'decode', 'preempted', 'transfer_wait', 'transferring', 'decode_wait'];
const inFlight = (e: SimulationEngine) => e.requests.some(r => IN_FLIGHT.includes(r.status));
const drain = (e: SimulationEngine, limit = 30000) => {
  for (let i = 0; i < limit && (inFlight(e) || (e.workload?.pending ?? 0) > 0); i++) e.step();
  expect(e.requests.every(r => ['completed', 'rejected', 'cancelled'].includes(r.status))).toBe(true);
};
const quiet = (e: SimulationEngine) => { e.setTraffic(null); };

describe('SimulationEngine', () => {
  it('makes the pressure scenario demonstrate LRU eviction without oversized seed requests', () => {
    const e = createScenario('kv-pressure');
    quiet(e);
    drain(e);
    expect(e.metrics.rejected).toBe(0);
    expect(e.metrics.evictions).toBeGreaterThan(0);
  });

  it('drains every predefined scenario without leaking pages', () => {
    for (const s of SCENARIOS) {
      const e = createScenario(s.id);
      if (!s.requests?.length) quiet(e);
      drain(e);
      e.assertInvariants();
      const expected = s.requests?.length || s.count;
      expect(e.metrics.completed, s.id).toBe(expected);
    }
  });

  it('transitions through prefill and decode, conserves tokens and releases pages', () => {
    const e = new SimulationEngine({ prefixCaching: false });
    const r = e.enqueue(input);
    expect(r.status).toBe('waiting');
    e.step();
    expect(r.status).toBe('prefill');
    drain(e);
    expect(r.generated).toBe(12);
    expect(r.firstTokenAt).toBeGreaterThan(r.arrivedAt);
    expect(e.pools[0].blocks.every(b => b.owners.length === 0)).toBe(true);
    expect(e.metrics.ttft).toBeGreaterThan(0);
    expect(e.metrics.tpot).toBeGreaterThan(0);
    expect(e.metrics.completed).toBe(1);
  });

  it('fills a freed batch slot continuously but holds static cohorts', () => {
    for (const continuousBatching of [true, false]) {
      const e = new SimulationEngine({ gpuCount: 1, maxBatchSize: 2, continuousBatching });
      const short = e.enqueue({ ...input, outputTokens: 1 });
      e.enqueue({ ...input, outputTokens: 90 });
      const late = e.enqueue(input);
      while (short.status !== 'completed') e.step();
      e.step();
      expect(late.status === 'waiting').toBe(!continuousBatching);
    }
  });

  it('allocates non-contiguous physical pages incrementally and keeps them unique', () => {
    const e = new SimulationEngine({ gpuCount: 1, blockSize: 16 });
    const r = e.enqueue({ ...input, outputTokens: 200 });
    e.step();
    expect(r.blockTable.length).toBeLessThan(Math.ceil((64 + 200) / 16));
    for (let i = 0; i < 100; i++) {
      e.step();
      expect(new Set(r.blockTable).size).toBe(r.blockTable.length);
      e.assertInvariants();
    }
  });

  it('reuses only complete prefix blocks and lowers warm TTFT', () => {
    const e = new SimulationEngine({ gpuCount: 1, prefixCaching: true });
    const cold = e.enqueue({ promptTokens: 256, outputTokens: 2, prefix: 'chat' });
    drain(e);
    const warm = e.enqueue({ promptTokens: 256, outputTokens: 2, prefix: 'chat' });
    drain(e);
    expect(warm.cachedTokens).toBe(128);
    expect(warm.firstTokenAt! - warm.arrivedAt).toBeLessThan(cold.firstTokenAt! - cold.arrivedAt);
    expect(e.metrics.prefixHitRate).toBe(50);
  });

  it('evicts only unreferenced cached pages under pressure and always makes progress', () => {
    const e = new SimulationEngine({ gpuCount: 1, numBlocks: 16, blockSize: 16, maxBatchSize: 8 });
    e.enqueue({ promptTokens: 128, outputTokens: 1, prefix: 'chat' });
    drain(e);
    for (let i = 0; i < 8; i++) e.enqueue({ promptTokens: 128, outputTokens: 96, prefix: 'none' });
    for (let i = 0; i < 4000; i++) { e.step(); e.assertInvariants(); }
    expect(e.metrics.completed).toBe(9);
    expect(e.metrics.evictions).toBeGreaterThan(0);
  });

  it('rejects a request larger than the pool without blocking small requests', () => {
    const e = new SimulationEngine({ gpuCount: 1, numBlocks: 16, blockSize: 8 });
    const large = e.enqueue({ ...input, promptTokens: 4096 });
    e.enqueue(input);
    drain(e);
    expect(large.status).toBe('rejected');
    expect(e.metrics.completed).toBe(1);
  });

  it('cancels active and waiting requests without leaking references', () => {
    const e = new SimulationEngine({ gpuCount: 1, maxBatchSize: 1 });
    const a = e.enqueue(input);
    const b = e.enqueue(input);
    e.step();
    e.cancel(a.id); e.cancel(b.id);
    e.assertInvariants();
    expect(e.metrics.active).toBe(0);
    expect(e.metrics.waiting).toBe(0);
    expect(e.pools[0].blocks.every(b => !b.owners.length)).toBe(true);
  });

  it('makes TP ranks share one batch and partitions GPUs into replicas', () => {
    const e = new SimulationEngine({ gpuCount: 4, tensorParallel: 2 });
    e.burst(12, input);
    e.step(20);
    expect(e.pools).toHaveLength(2);
    expect(e.workers).toHaveLength(4);
    expect(e.workers[0].requestIds).toEqual(e.workers[1].requestIds);
    expect(e.workers[0].group).not.toBe(e.workers[2].group);
    e.assertInvariants();
  });

  it('speculation accepts a bounded prefix and never exceeds requested output', () => {
    const e = new SimulationEngine({ speculativeDecoding: true });
    e.burst(8, { ...input, outputTokens: 31 });
    drain(e);
    expect(e.requests.every(r => r.generated === r.outputTokens)).toBe(true);
    expect(e.metrics.drafted).toBeGreaterThan(0);
    expect(e.metrics.accepted).toBeGreaterThan(0);
    expect(e.metrics.accepted).toBeLessThanOrEqual(e.metrics.drafted);
  });

  it('replays deterministically and normalizes invalid hardware configuration', () => {
    const a = new SimulationEngine({ gpuCount: 3, tensorParallel: 8 }, 42);
    const b = new SimulationEngine({ gpuCount: 3, tensorParallel: 8 }, 42);
    a.burst(6, input); b.burst(6, input);
    a.step(500); b.step(500);
    expect(a.requests).toEqual(b.requests);
    expect(a.config.gpuCount % a.config.tensorParallel).toBe(0);
    expect(a.metrics).toEqual(b.metrics);
  });

  it('reports zero rolling throughput and GPU utilization after becoming idle', () => {
    const e = new SimulationEngine();
    e.enqueue(input); drain(e); e.step(60);
    expect(e.metrics.tokensPerSecond).toBe(0);
    expect(e.metrics.requestsPerSecond).toBe(0);
    expect(e.metrics.gpuUtilization).toBe(0);
  });

  it('starts execution at admission, never inside the queue interval', () => {
    const e = new SimulationEngine({ gpuCount: 1, maxBatchSize: 1 });
    e.enqueue(input);
    const waiting = e.enqueue(input);
    drain(e);
    for (const r of e.requests) expect(r.spans[0].start).toBe(r.admittedAt);
    expect(waiting.admittedAt).toBeGreaterThan(waiting.arrivedAt);
  });

  it('shares immutable pages while retaining independent mutable tails', () => {
    const e = new SimulationEngine({ gpuCount: 1, maxBatchSize: 8 });
    e.enqueue({ promptTokens: 256, outputTokens: 1, prefix: 'chat' });
    drain(e);
    const a = e.enqueue({ promptTokens: 256, outputTokens: 30, prefix: 'chat' });
    const b = e.enqueue({ promptTokens: 256, outputTokens: 30, prefix: 'chat' });
    e.step(30);
    expect(a.blockTable.slice(0, 8)).toEqual(b.blockTable.slice(0, 8));
    expect(a.blockTable[8]).not.toBe(b.blockTable[8]);
    expect(e.pools[0].blocks[a.blockTable[0]].owners).toHaveLength(2);
    e.cancel(a.id);
    e.assertInvariants();
    expect(e.pools[0].blocks[b.blockTable[0]].owners).toEqual([b.id]);
    drain(e);
  });

  it('survives feature changes with active shared pages', () => {
    const e = new SimulationEngine({ gpuCount: 1 });
    e.enqueue({ promptTokens: 256, outputTokens: 1, prefix: 'chat' }); drain(e);
    e.burst(6, { promptTokens: 256, outputTokens: 10, prefix: 'chat' });
    e.step(10);
    e.setFeatures({ prefixCaching: false, continuousBatching: false, speculativeDecoding: true });
    e.assertInvariants();
    drain(e);
    expect(e.pools[0].blocks.every(b => b.key === null && b.owners.length === 0)).toBe(true);
  });

  it('conserves output and memory across 64 hardware and scheduler combinations', () => {
    for (const gpuCount of [1, 2, 4, 8]) for (const blockSize of [8, 16, 32, 64])
      for (const continuousBatching of [true, false]) for (const speculativeDecoding of [true, false]) {
        const e = new SimulationEngine({ gpuCount, tensorParallel: gpuCount, blockSize, numBlocks: 32, continuousBatching, speculativeDecoding }, 917);
        e.burst(12, { promptTokens: 64, outputTokens: 24, prefix: 'code' });
        for (let i = 0; i < 1600; i++) { e.step(); e.assertInvariants(); }
        expect(e.requests.every(r => r.status === 'completed')).toBe(true);
        expect(e.metrics.outputTokens).toBe(e.requests.reduce((n, r) => n + r.outputTokens, 0));
      }
  });
});

describe('Token budget & chunked prefill', () => {
  it('never schedules more tokens than the per-iteration budget', () => {
    const e = new SimulationEngine({ gpuCount: 1, maxNumBatchedTokens: 32, maxBatchSize: 8 });
    e.burst(8, { promptTokens: 512, outputTokens: 32, prefix: 'none' });
    for (let i = 0; i < 600; i++) {
      e.step();
      e.assertInvariants();
      const usage = e.lastBudget[0];
      expect(usage.decode + usage.prefill).toBeLessThanOrEqual(usage.total);
      expect(usage.decode + usage.prefill + usage.unused).toBe(usage.total);
    }
  });

  it('processes long prompts across multiple chunked iterations without overflow', () => {
    const e = new SimulationEngine({ gpuCount: 1, prefillChunkSize: 64, numBlocks: 512 });
    const r = e.enqueue({ promptTokens: 640, outputTokens: 8, prefix: 'none' });
    let chunkEvents = 0;
    while (r.status === 'waiting' || r.status === 'prefill') {
      e.step();
      chunkEvents = e.events.filter(x => x.type === 'chunk').length;
      expect(r.processed).toBeLessThanOrEqual(r.promptTokens);
      e.assertInvariants();
    }
    expect(chunkEvents).toBeGreaterThan(1);
    const prefillSpan = r.spans.find(s => s.phase === 'prefill');
    expect(prefillSpan).toBeDefined();
    expect(prefillSpan!.end - prefillSpan!.start).toBeGreaterThanOrEqual(20 * 10); // many iterations
    expect(r.processed).toBe(640);
    drain(e);
    expect(r.generated).toBe(8);
  });

  it('decode priority keeps decodes moving while a long prefill consumes the budget', () => {
    const run = (decodePriority: boolean) => {
      const e = new SimulationEngine({
        gpuCount: 1, maxBatchSize: 8, maxNumBatchedTokens: 32, prefillChunkSize: 0, decodePriority, numBlocks: 256,
      });
      const decoder = e.enqueue({ promptTokens: 32, outputTokens: 200, prefix: 'none' });
      // Let the decoder reach decode phase first.
      while (decoder.status !== 'decode') e.step();
      const stall = e.enqueue({ promptTokens: 2048, outputTokens: 8, prefix: 'none' });
      const before = decoder.generated;
      for (let i = 0; i < 40; i++) e.step();
      return { decoder, stall, progressed: decoder.generated - before, budget: e.lastBudget[0] };
    };
    const priority = run(true);
    expect(priority.progressed).toBeGreaterThan(0);
    expect(priority.stall.processed).toBeLessThan(2048);
    const noPriority = run(false);
    expect(noPriority.progressed).toBe(0);
    expect(noPriority.budget.prefill).toBe(32);
  });

  it('counts scheduler iterations and reports token budget utilization', () => {
    const e = new SimulationEngine();
    e.burst(4, { promptTokens: 256, outputTokens: 32, prefix: 'none' });
    e.step(100);
    expect(e.metrics.schedulerIterations).toBe(100);
    expect(e.metrics.tokenBudgetUtilization).toBeGreaterThan(0);
    expect(e.metrics.tokenBudgetUtilization).toBeLessThanOrEqual(100);
  });
});

describe('Request shape helpers', () => {
  it('never generates beyond the requested output length', () => {
    const e = new SimulationEngine({ gpuCount: 2, maxBatchSize: 8 });
    const rs: Request[] = e.burst(10, { promptTokens: 128, outputTokens: 17, prefix: 'chat' });
    drain(e);
    for (const r of rs) expect(r.generated).toBe(r.outputTokens);
  });
});
