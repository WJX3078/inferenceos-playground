import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine';
import { normalizeConfig } from './types';

describe('token budget scheduler', () => {
  it('chunks a 4096-token prompt into observable 512-token allocations', () => {
    const e = new SimulationEngine({ gpuCount: 1, numBlocks: 512, maxPrefillTokensPerStep: 512 });
    const r = e.enqueue({ promptTokens: 4096, outputTokens: 1, prefix: 'none' });
    for (let i = 1; i <= 8; i++) {
      e.step();
      expect(r.processed).toBe(i * 512);
      expect(e.iterations.at(-1)!.prefillTokens).toBe(512);
    }
    expect(r.spans.filter(s => s.phase === 'prefill')).toHaveLength(8);
    expect(r.status).toBe('decode');
  });
  it('co-schedules decode and prefill and accounts for speculative verification within budget', () => {
    const e = new SimulationEngine({ gpuCount: 1, maxNumBatchedTokens: 17, maxPrefillTokensPerStep: 16, speculativeDecoding: true });
    e.enqueue({ promptTokens: 1, outputTokens: 20, prefix: 'none' });
    e.step();
    e.enqueue({ promptTokens: 512, outputTokens: 3, prefix: 'none' });
    for (let i = 0; i < 80; i++) {
      e.step();
      e.assertInvariants();
      const s = e.iterations.at(-1)!;
      expect(s.used).toBe(s.prefillTokens + s.decodeTokens);
      expect(s.used).toBeLessThanOrEqual(17);
      expect(s.scheduled.reduce((n, a) => n + a.tokens, 0)).toBe(s.used);
    }
    expect(e.iterations.some(s => s.prefillTokens > 0 && s.decodeTokens > 0)).toBe(true);
  });
  it('bounds sequences and progresses with a one-token budget', () => {
    const e = new SimulationEngine({ gpuCount: 1, maxNumSeqs: 2, maxNumBatchedTokens: 1, prefixCaching: false });
    for (let i = 0; i < 4; i++) e.enqueue({ promptTokens: 5, outputTokens: 4, prefix: 'none' });
    for (let i = 0; i < 200; i++) {
      e.step();
      expect(e.metrics.active).toBeLessThanOrEqual(2);
      e.assertInvariants();
    }
    expect(e.metrics.completed).toBe(4);
    expect(e.iterations.some(s => s.skipped.some(r => r.reason === 'Token budget exhausted'))).toBe(true);
  });
  it('keeps maxBatchSize as a compatible alias and normalizes budget inputs', () => {
    expect(normalizeConfig({ maxBatchSize: 7 }).maxNumSeqs).toBe(7);
    expect(normalizeConfig({ maxNumSeqs: 3 }).maxBatchSize).toBe(3);
    expect(normalizeConfig({ maxNumBatchedTokens: NaN }).maxNumBatchedTokens).toBe(1);
  });
});
