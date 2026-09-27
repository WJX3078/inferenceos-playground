import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine';
import { createScenario } from './scenarios';

const IN_FLIGHT = ['waiting', 'prefill', 'decode', 'preempted', 'transfer_wait', 'transferring', 'decode_wait'];
const inFlight = (e: SimulationEngine) => e.requests.some(r => IN_FLIGHT.includes(r.status));

describe('Disaggregated serving', () => {
  it('builds prefill and decode pools from the P/D allocation and maps workers', () => {
    const e = new SimulationEngine({
      servingMode: 'disaggregated', gpuCount: 8, prefillGpuCount: 2, decodeGpuCount: 6,
      prefillTP: 2, decodeTP: 2,
    });
    expect(e.pools).toHaveLength(4); // 1 prefill replica (2 GPUs) + 3 decode replicas (2 GPUs each)
    expect(e.poolKinds.filter(k => k === 'prefill')).toHaveLength(1);
    expect(e.poolKinds.filter(k => k === 'decode')).toHaveLength(3);
    expect(e.workers).toHaveLength(8);
    e.assertInvariants();
  });

  it('walks the full lifecycle: prefill -> transfer -> decode_wait -> decode -> completed', () => {
    const e = createScenario('disaggregated-balanced');
    e.setTraffic(null);
    const r = e.requests[0];
    const seen = new Set<string>([r.status]);
    for (let i = 0; i < 2000 && r.status !== 'completed'; i++) {
      e.step();
      seen.add(r.status);
      e.assertInvariants();
    }
    expect(r.status).toBe('completed');
    expect(seen.has('prefill')).toBe(true);
    expect(seen.has('transfer_wait') || seen.has('transferring')).toBe(true);
    expect(seen.has('decode_wait')).toBe(true);
    expect(seen.has('decode')).toBe(true);
    expect(r.prefillGroup).not.toBe(r.decodeGroup);
    expect(r.transfer?.finishedAt).toBeDefined();
  });

  it('TTFT includes the KV transfer, and transfer metrics are recorded', () => {
    const e = createScenario('network-bottleneck');
    e.setTraffic(null);
    for (let i = 0; i < 3000 && inFlight(e); i++) e.step();
    const m = e.metrics;
    expect(m.transfersCompleted).toBeGreaterThan(0);
    expect(m.networkBytes).toBeGreaterThan(0);
    const obs = e.collector.observations.find(o => o.kvTransferLatency !== null);
    expect(obs).toBeDefined();
    // TTFT = prefill queue + prefill + transfer queue + transfer + decode queue
    expect(obs!.ttft!).toBeGreaterThanOrEqual((obs!.kvTransferLatency ?? 0) + (obs!.prefillLatency ?? 0));
  });

  it('decode never starts before its KV transfer finished (all requests)', () => {
    const e = createScenario('disaggregated-prefill-bottleneck');
    e.setTraffic(null);
    for (let i = 0; i < 2000; i++) {
      e.step();
      for (const r of e.requests) {
        if (r.status === 'decode') {
          expect(r.transfer).toBeDefined();
          expect(r.transfer!.finishedAt).toBeDefined();
          expect(r.decodeGroup).not.toBeNull();
        }
      }
      if (i % 50 === 0) e.assertInvariants();
    }
  });

  it('lower transfer bandwidth queues transfers and stretches TTFT', () => {
    const run = (bandwidth: number) => {
      const e = new SimulationEngine({
        servingMode: 'disaggregated', gpuCount: 4, prefillGpuCount: 2, decodeGpuCount: 2,
        numBlocks: 128, kvTransferBandwidthGBps: bandwidth, maxConcurrentTransfers: 2,
      });
      e.burst(6, { promptTokens: 1024, outputTokens: 32, prefix: 'chat' });
      for (let i = 0; i < 4000 && inFlight(e); i++) e.step();
      return { ttftP99: e.metrics.ttftP99 ?? 0, queued: e.metrics.transfersQueued, done: e.metrics.transfersCompleted };
    };
    const fast = run(64);
    const slow = run(4);
    expect(slow.ttftP99).toBeGreaterThan(fast.ttftP99);
    expect(fast.done).toBeGreaterThan(0);
    expect(slow.done).toBeGreaterThan(0);
  });

  it('P/D mismatch moves the wait: 2P+6D queues before prefill, 6P+2D queues before decode admission', () => {
    const run = (prefillGpuCount: number) => {
      const e = new SimulationEngine({
        servingMode: 'disaggregated', gpuCount: 8, prefillGpuCount, decodeGpuCount: 8 - prefillGpuCount,
        numBlocks: 256, maxBatchSize: 8,
      });
      e.burst(20, { promptTokens: 1024, outputTokens: 64, prefix: 'chat' });
      for (let i = 0; i < 8000 && inFlight(e); i++) e.step();
      const obs = e.collector.observations;
      const median = (xs: number[]) => {
        const s = [...xs].sort((a, b) => a - b);
        return s.length ? s[Math.floor(s.length / 2)] : 0;
      };
      return {
        prefillQueue: median(obs.map(o => o.prefillQueueLatency ?? 0)),
        decodeQueue: median(obs.map(o => o.decodeQueueLatency ?? 0)),
        transferQueue: median(obs.map(o => o.kvTransferQueueLatency ?? 0)),
      };
    };
    const prefillBottleneck = run(2);
    const decodeBottleneck = run(6);
    // Prefill-poor: requests wait a long time before even entering prefill.
    expect(prefillBottleneck.prefillQueue).toBeGreaterThan(prefillBottleneck.transferQueue);
    // Prefill-rich: prefill admission is quick but the small decode pool backs
    // up transfer staging (decode KV/batch capacity is the binding constraint).
    expect(decodeBottleneck.transferQueue).toBeGreaterThan(decodeBottleneck.prefillQueue);
    expect(decodeBottleneck.transferQueue).toBeGreaterThan(0);
  });

  it('cancelling a decode_wait request releases its decode-pool blocks', () => {
    const e = createScenario('disaggregated-decode-bottleneck');
    e.setTraffic(null);
    let victim: typeof e.requests[number] | null = null;
    for (let i = 0; i < 4000 && !victim; i++) {
      e.step();
      victim = e.requests.find(r => r.status === 'decode_wait') ?? null;
    }
    expect(victim).not.toBeNull();
    const pool = e.pools[victim!.decodeGroup!];
    const pinnedBefore = pool.pinned;
    expect(pinnedBefore).toBeGreaterThan(0);
    e.cancel(victim!.id);
    e.assertInvariants();
    expect(victim!.status).toBe('cancelled');
    expect(pool.pinned).toBeLessThan(pinnedBefore);
  });
});
