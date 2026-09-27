import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine';

// v1.0 hardening features: aging/starvation protection, cost-aware
// preemption, transfer scheduling policies and P/D backpressure.

const IN_FLIGHT = ['waiting', 'prefill', 'decode', 'preempted', 'transfer_wait', 'transferring', 'decode_wait'];
const inFlight = (e: SimulationEngine) => e.requests.some(r => IN_FLIGHT.includes(r.status));

describe('Starvation protection (aging)', () => {
  it('eventually admits a long request starved by SJF under sustained short load', () => {
    const e = new SimulationEngine({
      gpuCount: 1, maxBatchSize: 2, schedulerPolicy: 'sjf', numBlocks: 256,
      starvationThresholdMs: 2000,
    });
    const long = e.enqueue({ promptTokens: 2048, outputTokens: 256, prefix: 'none', priority: 'normal' });
    // Step a few ticks so the long request is first in queue, then flood shorts.
    e.step();
    for (let i = 0; i < 200; i++) {
      e.enqueue({ promptTokens: 64, outputTokens: 8, prefix: 'none' });
      e.step(8);
    }
    expect(e.metrics.starvationEvents).toBeGreaterThan(0);
    // The aged request must make progress (admitted -> prefill/decode).
    expect(long.processed > 0 || long.generated > 0).toBe(true);
    e.assertInvariants();
  });

  it('does not fire aging when the threshold is disabled', () => {
    const e = new SimulationEngine({ gpuCount: 1, schedulerPolicy: 'sjf', starvationThresholdMs: 0 });
    e.enqueue({ promptTokens: 2048, outputTokens: 8, prefix: 'none' });
    e.enqueue({ promptTokens: 32, outputTokens: 4, prefix: 'none' });
    e.step(30);
    expect(e.metrics.starvationEvents).toBe(0);
  });

  it('reports the maximum observed queue wait', () => {
    const e = new SimulationEngine({ gpuCount: 1, maxBatchSize: 1, starvationThresholdMs: 0 });
    e.enqueue({ promptTokens: 512, outputTokens: 32, prefix: 'none' });
    const queued = e.enqueue({ promptTokens: 64, outputTokens: 8, prefix: 'none' });
    while (e.requests.some(r => r.status !== 'completed')) e.step();
    const obs = e.collector.observations.find(o => o.id === queued.id)!;
    expect(e.metrics.maxQueueWait).toBeGreaterThanOrEqual(obs.queueLatency);
    expect(e.metrics.maxQueueWait).toBeGreaterThan(0);
  });
});

describe('Cost-aware preemption', () => {
  it('prefers the cheapest victim among outranked running requests', () => {
    const e = new SimulationEngine({
      gpuCount: 1, maxBatchSize: 2, numBlocks: 256, schedulerPolicy: 'priority',
      preemptionMode: 'cost-aware', preemptionCooldownMs: 0,
    });
    // Two same-class (normal) runners can never preempt each other; instead
    // verify cost choice among LOW victims by a HIGH arrival: the one with
    // less invested context should be evicted.
    const young = e.enqueue({ promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'low' });
    e.step(2);
    const old = e.enqueue({ promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'low' });
    e.step(60); // young decodes (invested), old still prefilling? both progress one-per-tick; young has more context
    const high = e.enqueue({ promptTokens: 64, outputTokens: 8, prefix: 'none', priority: 'high' });
    let victim = null as typeof e.requests[number] | null;
    for (let i = 0; i < 40 && !victim; i++) {
      e.step();
      victim = e.requests.find(r => r.preemptions > 0) ?? null;
    }
    expect(victim).not.toBeNull();
    // The cheap victim is the one with less context work to recompute.
    const costs = new Map(e.requests.filter(r => r.priority === 'low').map(r => [r.id, r.promptTokens + r.generated - r.cachedTokens]));
    const victimCost = costs.get(victim!.id)!;
    const otherCost = Math.min(...[...costs.entries()].filter(([id]) => id !== victim!.id).map(([, c]) => c));
    expect(victimCost).toBeLessThanOrEqual(otherCost);
  });

  it('enforces the minimum residency: fresh requests are not evicted instantly', () => {
    const e = new SimulationEngine({
      gpuCount: 1, maxBatchSize: 1, numBlocks: 96, schedulerPolicy: 'priority',
      preemptionMode: 'cost-aware', preemptionCooldownMs: 0,
    });
    const low = e.enqueue({ promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'low' });
    e.step(1); // admitted ~now, residency < 200ms
    const high = e.enqueue({ promptTokens: 64, outputTokens: 8, prefix: 'none', priority: 'high' });
    for (let i = 0; i < 12; i++) e.step(); // ~240ms pass; residency unlocks
    expect(low.preemptions).toBeGreaterThan(0);
  });

  it('cooldown suppresses preemption storms', () => {
    const e = new SimulationEngine({
      gpuCount: 1, maxBatchSize: 1, numBlocks: 512, schedulerPolicy: 'priority',
      preemptionMode: 'cost-aware', preemptionCooldownMs: 1000,
    });
    const runner = e.enqueue({ promptTokens: 256, outputTokens: 400, prefix: 'none', priority: 'low' });
    e.step(2);
    for (let i = 0; i < 6; i++) {
      e.enqueue({ promptTokens: 64, outputTokens: 8, prefix: 'none', priority: 'high' });
      e.step(5);
    }
    // Cooldown 1000ms allows at most one preemption per 50 ticks.
    expect(e.metrics.preemptions).toBeLessThanOrEqual(3);
    void runner;
  });

  it('prefill-only mode never evicts decoding requests', () => {
    const e = new SimulationEngine({
      gpuCount: 1, maxBatchSize: 1, numBlocks: 96, schedulerPolicy: 'priority',
      preemptionMode: 'prefill-only', preemptionCooldownMs: 0,
    });
    const decoder = e.enqueue({ promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'low' });
    while (decoder.status !== 'decode') e.step();
    const high = e.enqueue({ promptTokens: 64, outputTokens: 8, prefix: 'none', priority: 'high' });
    for (let i = 0; i < 400 && e.requests.some(r => r.status !== 'completed'); i++) e.step();
    // The decoder runs to completion without ever being evicted; the high
    // request waits for the batch slot and then runs.
    expect(decoder.preemptions).toBe(0);
    expect(decoder.generated).toBe(64);
    expect(high.generated).toBe(8);
  });
});

describe('Transfer scheduling policies', () => {
  const run = (policy: 'fair-share' | 'fifo' | 'priority') => {
    const e = new SimulationEngine({
      servingMode: 'disaggregated', gpuCount: 4, prefillGpuCount: 2, decodeGpuCount: 2,
      numBlocks: 256, maxConcurrentTransfers: 1, transferSchedulingPolicy: policy,
      kvTransferBandwidthGBps: 16,
    });
    e.enqueue({ promptTokens: 1024, outputTokens: 32, prefix: 'chat', priority: 'low' });
    e.enqueue({ promptTokens: 1024, outputTokens: 32, prefix: 'chat', priority: 'high' });
    for (let i = 0; i < 4000 && inFlight(e); i++) e.step();
    return { done: e.metrics.transfersCompleted, wait99: e.metrics.transferWaitP99 };
  };

  it('all policies complete the same transfers (mechanism, not fairness, differs)', () => {
    for (const policy of ['fair-share', 'fifo', 'priority'] as const) {
      const r = run(policy);
      expect(r.done).toBe(2);
      expect(r.wait99).not.toBeNull();
    }
  });

  it('fifo serves the head of the queue at full line rate', () => {
    const e = new SimulationEngine({
      servingMode: 'disaggregated', gpuCount: 2, prefillGpuCount: 1, decodeGpuCount: 1,
      numBlocks: 512, maxConcurrentTransfers: 2, transferSchedulingPolicy: 'fifo',
      kvTransferBandwidthGBps: 8,
    });
    // 4096-token prompts -> 512 MiB transfers; at 8 GB/s the head gets the
    // whole pipe (~64 ms) while the second waits (fair-share would give each
    // ~128 ms with both in flight).
    e.enqueue({ promptTokens: 4096, outputTokens: 16, prefix: 'chat' });
    e.enqueue({ promptTokens: 4096, outputTokens: 16, prefix: 'chat' });
    for (let i = 0; i < 4000 && inFlight(e); i++) e.step();
    expect(e.metrics.transfersCompleted).toBe(2);
    const [first] = e.transfers.log;
    const serviceMs = first.finishedAt! - first.startedAt!;
    expect(serviceMs).toBeLessThan(100); // full-rate service, not split
  });
});

describe('P/D backpressure', () => {
  it('pauses prefill admission when the decode pipeline saturates', () => {
    const e = new SimulationEngine({
      servingMode: 'disaggregated', gpuCount: 4, prefillGpuCount: 2, decodeGpuCount: 2,
      numBlocks: 128, maxBatchSize: 8, maxPendingDecodeRequests: 4,
      kvTransferBandwidthGBps: 16,
    });
    // More requests than the prefill pools can hold at once and a slow decode
    // side: waiting requests pile up and the backpressure gate holds them.
    e.burst(40, { promptTokens: 256, outputTokens: 128, prefix: 'chat' });
    let sawBackpressure = false;
    let maxWaiting = 0;
    for (let i = 0; i < 6000 && inFlight(e); i++) {
      e.step();
      sawBackpressure ||= e.admission.backpressureActive;
      maxWaiting = Math.max(maxWaiting, e.metrics.waiting);
    }
    expect(sawBackpressure).toBe(true);
    expect(e.metrics.backpressureEvents).toBeGreaterThan(0);
    expect(e.metrics.backpressureTicks).toBeGreaterThan(0);
    expect(maxWaiting).toBeGreaterThan(0);
    expect(e.metrics.completed).toBe(40);
  });

  it('does not activate without the limit', () => {
    const e = new SimulationEngine({
      servingMode: 'disaggregated', gpuCount: 4, prefillGpuCount: 2, decodeGpuCount: 2,
      numBlocks: 128, maxBatchSize: 8, maxPendingDecodeRequests: 0,
      kvTransferBandwidthGBps: 4,
    });
    e.burst(14, { promptTokens: 1024, outputTokens: 32, prefix: 'chat' });
    for (let i = 0; i < 2000 && inFlight(e); i++) e.step();
    expect(e.metrics.backpressureEvents).toBe(0);
  });
});
