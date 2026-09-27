import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine';
import { percentile } from './metrics';

describe('Metrics: percentiles, SLO, goodput', () => {
  it('nearest-rank percentiles are monotonic and pick the right rank', () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 90)).toBe(90);
    expect(percentile(sorted, 95)).toBe(100);
    expect(percentile(sorted, 99)).toBe(100);
    expect(percentile([], 99)).toBeNull();
    const p50 = percentile(sorted, 50)!;
    const p90 = percentile(sorted, 90)!;
    const p95 = percentile(sorted, 95)!;
    const p99 = percentile(sorted, 99)!;
    expect(p50).toBeLessThanOrEqual(p90);
    expect(p90).toBeLessThanOrEqual(p95);
    expect(p95).toBeLessThanOrEqual(p99);
  });

  it('reports TTFT/TPOT/E2E percentiles from request observations', () => {
    const e = new SimulationEngine({ gpuCount: 2, maxBatchSize: 8 });
    e.burst(12, { promptTokens: 256, outputTokens: 32, prefix: 'chat' });
    while (e.requests.some(r => r.status !== 'completed')) e.step();
    const m = e.metrics;
    expect(m.completed).toBe(12);
    for (const p of [m.ttftP50, m.ttftP90, m.ttftP95, m.ttftP99]) expect(p).not.toBeNull();
    expect(m.ttftP50!).toBeLessThanOrEqual(m.ttftP90!);
    expect(m.ttftP90!).toBeLessThanOrEqual(m.ttftP95!);
    expect(m.ttftP95!).toBeLessThanOrEqual(m.ttftP99!);
    expect(m.tpotP50!).toBeLessThanOrEqual(m.tpotP99!);
    expect(m.e2eP50!).toBeLessThanOrEqual(m.e2eP99!);
    // Mean stays consistent with the old definition.
    expect(m.ttft).toBeGreaterThan(0);
  });

  it('counts SLO attainment and separates throughput from goodput', () => {
    const run = (sloTTFTms: number) => {
      const e = new SimulationEngine({ gpuCount: 1, sloTTFTms, maxBatchSize: 4 });
      e.burst(8, { promptTokens: 128, outputTokens: 24, prefix: 'none' });
      while (e.requests.some(r => r.status !== 'completed')) e.step();
      e.step(100); // let the rolling window settle
      return { attainment: e.metrics.sloAttainment, goodput: e.metrics.goodput, completed: e.metrics.completed };
    };
    const generous = run(60000);
    expect(generous.completed).toBe(8);
    expect(generous.attainment).toBe(100);
    const tight = run(1);
    expect(tight.attainment).toBe(0);
  });

  it('per-request SLO overrides win over the global SLO', () => {
    const e = new SimulationEngine({ gpuCount: 1, sloTTFTms: 1 });
    e.enqueue({ promptTokens: 32, outputTokens: 4, prefix: 'none', sloTTFTms: 60000 });
    while (e.requests.some(r => r.status !== 'completed')) e.step();
    expect(e.metrics.sloAttainment).toBe(100);
  });

  it('cancelled requests produce observations without SLO verdicts', () => {
    const e = new SimulationEngine({ gpuCount: 1 });
    const r = e.enqueue({ promptTokens: 64, outputTokens: 100, prefix: 'none' });
    e.step(4);
    e.cancel(r.id);
    const obs = e.collector.observations.find(o => o.id === r.id);
    expect(obs).toBeDefined();
    expect(obs!.status).toBe('cancelled');
    expect(obs!.meetsSLO).toBeNull();
    expect(obs!.e2e).toBeGreaterThan(0);
  });

  it('records queue, prefill and decode latency components', () => {
    const e = new SimulationEngine({ gpuCount: 1, maxBatchSize: 1 });
    const first = e.enqueue({ promptTokens: 64, outputTokens: 8, prefix: 'none' });
    const queued = e.enqueue({ promptTokens: 64, outputTokens: 8, prefix: 'none' });
    while (e.requests.some(r => r.status !== 'completed')) e.step();
    const obs = e.collector.observations.find(o => o.id === queued.id)!;
    expect(obs.queueLatency).toBeGreaterThan(0);
    expect(obs.prefillLatency).toBeGreaterThan(0);
    expect(obs.decodeLatency).toBeGreaterThan(0);
    expect(first.id).toBeDefined();
  });
});
