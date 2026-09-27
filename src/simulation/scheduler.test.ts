import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine';
import { createScheduler } from './scheduler';
import { sloUrgency } from './scheduler/slo';
import type { SchedulingContext } from './scheduler/types';
import { createScenario } from './scenarios';
import { normalizeConfig } from './types';
import type { Request } from './types';

const ctx: SchedulingContext = { config: normalizeConfig({}), now: 0 };

const mk = (over: Partial<Request>): Request => ({
  promptTokens: 100, outputTokens: 10, prefix: 'none', id: 'R000', status: 'waiting',
  arrivedAt: 0, priority: 'normal', sloTTFT: 500, sloTPOT: 50, tokenSeed: 1,
  group: null, prefillGroup: null, decodeGroup: null, processed: 0, generated: 0,
  cachedTokens: 0, prefixTokens: 0, blockTable: [], compute: 0, reason: '', spans: [],
  preemptions: 0, recomputedTokens: 0, transfer: null, restore: null, tierHit: null,
  resumeTarget: null, speculative: null,
  ...over,
});

describe('Scheduler policies', () => {
  it('FCFS orders strictly by arrival time with id tie-break', () => {
    const s = createScheduler('fcfs', () => 32);
    const a = mk({ id: 'R002', arrivedAt: 10 });
    const b = mk({ id: 'R001', arrivedAt: 10 });
    const c = mk({ id: 'R003', arrivedAt: 5 });
    expect(s.order([a, b, c], ctx).map(r => r.id)).toEqual(['R003', 'R001', 'R002']);
  });

  it('SJF orders by shortest remaining work (including recompute debt)', () => {
    const s = createScheduler('sjf', () => 32);
    const short = mk({ id: 'R001', promptTokens: 100, outputTokens: 10 });
    const long = mk({ id: 'R002', promptTokens: 500, outputTokens: 100 });
    const resumed = mk({ id: 'R003', promptTokens: 100, outputTokens: 10, generated: 5, status: 'preempted', preemptions: 1 });
    // resumed: contextTarget 105 + remaining output 5 = 110 > 110? contextTarget-prompt processed: 105 + 5 = 110 vs short 110 -> tie broken by arrival below
    expect(s.order([long, short, resumed], ctx).map(r => r.id)).toEqual(['R001', 'R003', 'R002']);
  });

  it('priority scheduler sorts classes high > normal > low, arrival within class', () => {
    const s = createScheduler('priority', () => 32);
    const low = mk({ id: 'R001', priority: 'low' });
    const highLate = mk({ id: 'R002', priority: 'high', arrivedAt: 100 });
    const normal = mk({ id: 'R003', priority: 'normal' });
    const highEarly = mk({ id: 'R004', priority: 'high', arrivedAt: 50 });
    expect(s.order([low, highLate, normal, highEarly], ctx).map(r => r.id))
      .toEqual(['R004', 'R002', 'R003', 'R001']);
  });

  it('SLO urgency flags requests that will miss their TTFT deadline', () => {
    const cfg = { sloTTFTms: 500, sloTPOTms: 50 };
    const now = 400;
    const soon = mk({ id: 'R001', arrivedAt: 0, promptTokens: 64 });     // deadline 500, slack 100
    const late = mk({ id: 'R002', arrivedAt: 0, promptTokens: 2048 });   // needs ~64 iterations: violates
    const passed = mk({ id: 'R003', arrivedAt: 0, promptTokens: 64 });   // evaluated after deadline
    const uSoon = sloUrgency(soon, { config: cfg as never, now }, 32);
    const uLate = sloUrgency(late, { config: cfg as never, now }, 32);
    const uPassed = sloUrgency(passed, { config: cfg as never, now: 1000 }, 32);
    expect(uSoon).toBeLessThan(1);      // predicted to make it
    expect(uLate).toBeGreaterThan(1);   // predicted miss
    expect(uPassed).toBeGreaterThan(1e9); // already violated band
  });

  it('the priority scheduler preempts only strictly lower classes', () => {
    const s = createScheduler('priority', () => 32);
    const high = mk({ id: 'R001', priority: 'high' });
    const low = mk({ id: 'R002', priority: 'low' });
    const otherHigh = mk({ id: 'R003', priority: 'high' });
    expect(s.outranks(high, low, ctx)).toBe(true);
    expect(s.outranks(low, high, ctx)).toBe(false);
    expect(s.outranks(high, otherHigh, ctx)).toBe(false); // no same-class preemption
  });

  it('FCFS preemption never evicts an older request', () => {
    const s = createScheduler('fcfs', () => 32);
    const old = mk({ id: 'R001', arrivedAt: 0 });
    const young = mk({ id: 'R002', arrivedAt: 100 });
    expect(s.outranks(old, young, ctx)).toBe(true);
    expect(s.outranks(young, old, ctx)).toBe(false);
  });
});

describe('Preemption (recompute)', () => {
  it('preempts a running request for a higher-priority one and releases its KV', () => {
    const e = new SimulationEngine({
      gpuCount: 1, maxBatchSize: 1, numBlocks: 96, schedulerPolicy: 'priority', preemptionMode: 'recompute',
    });
    const low = e.enqueue({ promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'low' });
    while (low.status !== 'decode') e.step();
    const pinnedBefore = e.pools[0].pinned;
    expect(pinnedBefore).toBeGreaterThan(0);
    const high = e.enqueue({ promptTokens: 256, outputTokens: 32, prefix: 'none', priority: 'high' });
    let sawPreempt = false;
    for (let i = 0; i < 200; i++) {
      e.step();
      const status: string = low.status;
      if (status === 'preempted' || low.preemptions > 0) { sawPreempt = true; break; }
    }
    expect(sawPreempt).toBe(true);
    expect(low.blockTable.length).toBe(0);
    for (let i = 0; i < 10 && high.status === 'waiting'; i++) e.step();
    expect(high.status === 'prefill' || high.status === 'decode').toBe(true);
    e.assertInvariants();
  });

  it('resumed requests recompute their context and still complete exactly', () => {
    const e = new SimulationEngine({
      gpuCount: 1, maxBatchSize: 1, numBlocks: 96, schedulerPolicy: 'priority', preemptionMode: 'recompute',
    });
    const low = e.enqueue({ promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'low' });
    while (low.status !== 'decode') e.step();
    const high = e.enqueue({ promptTokens: 256, outputTokens: 32, prefix: 'none', priority: 'high' });
    for (let i = 0; i < 8000 && e.requests.some(r => r.status !== 'completed'); i++) {
      e.step();
      e.assertInvariants();
    }
    expect(e.requests.every(r => r.status === 'completed')).toBe(true);
    expect(low.generated).toBe(64);
    expect(low.preemptions).toBeGreaterThan(0);
    expect(low.recomputedTokens).toBeGreaterThan(0);
    expect(high.generated).toBe(32);
    expect(e.collector.observations.find(o => o.id === low.id)?.recomputedTokens).toBeGreaterThan(0);
  });

  it('never deadlocks: a saturated pool with preemption still drains', () => {
    const e = new SimulationEngine({
      gpuCount: 1, numBlocks: 32, maxBatchSize: 4, schedulerPolicy: 'slo', preemptionMode: 'recompute',
      sloTTFTms: 200,
    });
    e.burst(10, { promptTokens: 384, outputTokens: 48, prefix: 'docs' });
    let withFlight = true;
    for (let i = 0; i < 20000 && (withFlight = e.requests.some(r =>
      ['waiting', 'prefill', 'decode', 'preempted'].includes(r.status))); i++) {
      e.step();
      if (i % 20 === 0) e.assertInvariants();
    }
    expect(withFlight).toBe(false);
    const m = e.metrics;
    expect(m.completed + m.rejected + m.cancelled).toBe(10);
    expect(m.completed).toBeGreaterThan(0);
  });
});

describe('Regression: core serving behaviors', () => {
  it('1. prefix cache hits reduce prefill work', () => {
    const e = new SimulationEngine({ gpuCount: 1 });
    const cold = e.enqueue({ promptTokens: 256, outputTokens: 4, prefix: 'chat' });
    while (cold.status === 'waiting' || cold.status === 'prefill') e.step();
    const coldWork = cold.processed;
    const warm = e.enqueue({ promptTokens: 256, outputTokens: 4, prefix: 'chat' });
    while (warm.status === 'waiting' || warm.status === 'prefill') e.step();
    expect(warm.cachedTokens).toBe(128);
    expect(warm.processed - warm.cachedTokens).toBeLessThan(coldWork);
  });

  it('2. chunked prefill never exceeds the token budget', () => {
    const e = new SimulationEngine({ gpuCount: 1, prefillChunkSize: 128, maxNumBatchedTokens: 64, numBlocks: 256 });
    e.enqueue({ promptTokens: 2048, outputTokens: 8, prefix: 'none' });
    for (let i = 0; i < 100; i++) {
      e.step();
      expect(e.lastBudget[0].prefill).toBeLessThanOrEqual(64);
    }
  });

  it('4. KV transfer must finish before decode admission (disaggregated)', () => {
    const e = createScenario('disaggregated-balanced');
    e.setTraffic(null);
    for (let i = 0; i < 600; i++) {
      e.step();
      for (const r of e.requests) {
        if (r.status === 'decode') expect(r.transfer?.finishedAt).toBeDefined();
      }
      e.assertInvariants();
    }
  });

  it('7. cancelling a request mid-transfer leaves nothing behind', () => {
    const e = createScenario('network-bottleneck');
    e.setTraffic(null);
    let victim = undefined as typeof e.requests[number] | undefined;
    for (let i = 0; i < 400 && !victim; i++) {
      e.step();
      victim = e.requests.find(r => r.status === 'transfer_wait' || r.status === 'transferring');
    }
    expect(victim).toBeDefined();
    const inPipeline = e.transfers.queue.some(x => x.requestId === victim!.id) ||
      e.transfers.active.some(x => x.requestId === victim!.id);
    expect(inPipeline).toBe(true);
    e.cancel(victim!.id);
    e.assertInvariants();
    expect(e.transfers.queue.some(x => x.requestId === victim!.id)).toBe(false);
    expect(e.transfers.active.some(x => x.requestId === victim!.id)).toBe(false);
    expect(victim!.status).toBe('cancelled');
  });

  it('8. speculative decoding never generates beyond the target output', () => {
    const e = new SimulationEngine({ speculativeDecoding: true, specDraftLength: 16, specAcceptance: 'high' });
    const requests = Array.from({ length: 6 }, () =>
      e.enqueue({ promptTokens: 64, outputTokens: 13, prefix: 'none' }));
    while (e.requests.some(r => r.status !== 'completed')) e.step();
    for (const r of requests) expect(r.generated).toBe(13);
  });

  it('9. same seed + config + workload replays identically', () => {
    const run = () => {
      const e = new SimulationEngine({ gpuCount: 2, speculativeDecoding: true }, 1234);
      e.burst(9, { promptTokens: 256, outputTokens: 48, prefix: 'code' });
      e.step(400);
      return e.exportRun();
    };
    const a = run(), b = run();
    expect(a.metrics).toEqual(b.metrics);
    expect(a.requests.map(r => [r.id, r.status, r.generated])).toEqual(b.requests.map(r => [r.id, r.status, r.generated]));
  });

  it('10. higher-priority requests are always scheduled before lower ones', () => {
    const e = new SimulationEngine({ gpuCount: 1, maxBatchSize: 1, schedulerPolicy: 'priority', numBlocks: 256 });
    const low = e.enqueue({ promptTokens: 256, outputTokens: 8, prefix: 'none', priority: 'low' });
    const high = e.enqueue({ promptTokens: 256, outputTokens: 8, prefix: 'none', priority: 'high' });
    e.step();
    while (high.status === 'waiting') e.step();
    expect(low.status).toBe('waiting');
    expect(high.admittedAt!).toBeLessThan((low.admittedAt ?? Infinity));
  });

  it('11. SLO metrics are counted correctly', () => {
    const e = new SimulationEngine({ gpuCount: 1, sloTTFTms: 20, sloTPOTms: 5 });
    e.enqueue({ promptTokens: 512, outputTokens: 64, prefix: 'none' });
    while (e.requests.some(r => r.status !== 'completed')) e.step();
    const m = e.metrics;
    expect(m.completed).toBe(1);
    expect(m.sloAttainment).toBe(0); // 512-token prompt cannot make a 20ms TTFT
    expect(m.goodput).toBe(0);
    expect(m.ttftP50).toBeGreaterThan(20);
  });
});
