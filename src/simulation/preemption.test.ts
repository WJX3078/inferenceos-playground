import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine';
import { effectivePriority } from './scheduler';

const input = { promptTokens: 64, outputTokens: 30, prefix: 'none' };
function drain(e: SimulationEngine) {
  for (let i = 0; i < 3000 && (e.metrics.active || e.metrics.waiting); i++) { e.step(); e.assertInvariants(); }
  expect(e.metrics.active + e.metrics.waiting).toBe(0);
}
describe('priority, aging and recomputation', () => {
  it('admits HIGH ahead of LOW, while FCFS preserves arrival order', () => {
    for (const schedulerPolicy of ['fcfs', 'priority'] as const) {
      const e = new SimulationEngine({ gpuCount: 1, maxNumSeqs: 1, schedulerPolicy });
      const low = e.enqueue({ ...input, priority: 'LOW' });
      const high = e.enqueue({ ...input, priority: 'HIGH' });
      e.step();
      expect((schedulerPolicy === 'priority' ? high : low).status).toBe('prefill');
      drain(e);
    }
  });
  it('ages queued LOW requests above new HIGH arrivals', () => {
    const e = new SimulationEngine();
    const low = e.enqueue({ ...input, priority: 'LOW' });
    const high = e.enqueue({ ...input, priority: 'HIGH' });
    high.waitingSince = 6000;
    expect(effectivePriority(low, 6000)).toBeGreaterThan(effectivePriority(high, 6000));
  });
  it('releases KV, requeues, rebuilds generated context and never emits output twice', () => {
    const e = new SimulationEngine({ gpuCount: 1, maxNumSeqs: 1, schedulerPolicy: 'priority', preemption: true, prefixCaching: false });
    const low = e.enqueue({ ...input, priority: 'LOW' });
    e.step(20);
    const emitted = low.generated;
    expect(emitted).toBeGreaterThan(0);
    const high = e.enqueue({ ...input, outputTokens: 2, priority: 'HIGH' });
    e.step();
    expect(low.status).toBe('waiting');
    expect(low.blockTable).toHaveLength(0);
    expect(e.pools[0].blocks.some(b => b.owners.includes(low.id))).toBe(false);
    expect(high.status).not.toBe('waiting');
    expect(low.generated).toBe(emitted);
    drain(e);
    expect(low.recomputedTokens).toBe(input.promptTokens + emitted);
    expect(low.preemptions).toBe(1);
    expect(low.spans.some(s => s.phase === 'recompute')).toBe(true);
    expect(e.metrics.outputTokens).toBe(32);
    expect(e.preemptionStats.recomputedTokens).toBe(low.recomputedTokens);
    expect(e.preemptionStats.overheadMs).toBeGreaterThan(0);
  });
  it('does not preempt for rejected contexts, or equal priority, and supports cancellation after preemption', () => {
    const e = new SimulationEngine({ gpuCount: 1, maxNumSeqs: 1, numBlocks: 16, schedulerPolicy: 'priority', preemption: true });
    const low = e.enqueue({ ...input, priority: 'LOW' });
    e.step(20);
    e.enqueue({ ...input, priority: 'LOW' });
    e.enqueue({ ...input, priority: 'HIGH', promptTokens: 8192 });
    e.step();
    expect(low.preemptions).toBe(0);
    // Preemption commits at a batch boundary, after outstanding collectives finish.
    while (e.inFlight[0]) e.step();
    e.enqueue({ ...input, priority: 'HIGH', outputTokens: 1 });
    e.step();
    expect(low.preemptions).toBe(1);
    e.cancel(low.id);
    drain(e);
    e.assertInvariants();
    expect(low.status).toBe('cancelled');
  });
});
