import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine';
const tokens = Array.from({ length: 64 }, (_, i) => i + 1);
function finish(e: SimulationEngine) { for (let i = 0; i < 300 && e.metrics.active + e.metrics.waiting; i++) { e.step(); e.assertInvariants(); } }
describe('block hash prefix cache', () => {
  it('matches identical tokens across family labels and stops at the first mismatch', () => {
    const e = new SimulationEngine({ gpuCount: 1, blockSize: 16 });
    e.enqueue({ promptTokens: 64, outputTokens: 1, prefix: 'chat', tokenIds: tokens });
    finish(e);
    const partial = e.enqueue({ promptTokens: 64, outputTokens: 1, prefix: 'code', tokenIds: tokens.map((t, i) => i === 34 ? 999 : t) });
    finish(e);
    expect(partial.cachedTokens).toBe(32);
    expect(partial.prefixLookup.map(b => b.hit)).toEqual([true, true, false, false]);
    expect(partial.prefixChain[3].hash).not.toBe(e.requests[0].prefixChain[3].hash);
    const exact = e.enqueue({ promptTokens: 64, outputTokens: 1, prefix: 'none', tokenIds: tokens });
    finish(e);
    expect(exact.cachedTokens).toBe(64);
    expect(exact.status).toBe('completed');
  });
  it('does not reuse mismatched content just because the family matches', () => {
    const e = new SimulationEngine({ gpuCount: 1, blockSize: 16 });
    e.enqueue({ promptTokens: 64, outputTokens: 1, prefix: 'chat', tokenIds: tokens });
    finish(e);
    const miss = e.enqueue({ promptTokens: 64, outputTokens: 1, prefix: 'chat', tokenIds: tokens.map(t => t + 1) });
    finish(e);
    expect(miss.cachedTokens).toBe(0);
    expect(miss.prefixLookup.every(b => !b.hit)).toBe(true);
  });
  it('shares complete blocks but never shares an incomplete mutable tail', () => {
    const e = new SimulationEngine({ gpuCount: 1, blockSize: 16 });
    const input = { promptTokens: 35, outputTokens: 20, prefix: 'chat', tokenIds: tokens.slice(0, 35) };
    e.enqueue(input); finish(e);
    const a = e.enqueue(input), b = e.enqueue(input);
    e.step(2);
    expect(a.cachedTokens).toBe(32);
    expect(a.blockTable.slice(0, 2)).toEqual(b.blockTable.slice(0, 2));
    expect(a.blockTable[2]).not.toBe(b.blockTable[2]);
    e.cancel(a.id); finish(e); e.assertInvariants();
  });
});
