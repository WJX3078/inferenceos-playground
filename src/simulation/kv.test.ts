import { describe, expect, it } from 'vitest';
import { blockHash, familyToken, requestToken } from './cache';
import { SimulationEngine } from './engine';
import { bytesPerToken, normalizeConfig } from './types';

const finished = (e: SimulationEngine) => e.requests.every(r => ['completed', 'rejected', 'cancelled'].includes(r.status));
const drain = (e: SimulationEngine, limit = 20000) => {
  for (let i = 0; i < limit && !finished(e); i++) e.step();
  expect(finished(e)).toBe(true);
};

describe('Prefix identity (content-addressed)', () => {
  it('computes identical block hashes for identical prefix content, different tails', () => {
    const e = new SimulationEngine({ gpuCount: 1 });
    const a = e.enqueue({ promptTokens: 256, outputTokens: 4, prefix: 'chat' });
    const b = e.enqueue({ promptTokens: 256, outputTokens: 4, prefix: 'chat' });
    const c = e.enqueue({ promptTokens: 256, outputTokens: 4, prefix: 'code' });
    expect(blockHash(a, 0, 16)).toBe(blockHash(b, 0, 16));
    expect(blockHash(a, 3, 16)).toBe(blockHash(b, 3, 16));
    expect(blockHash(a, 0, 16)).not.toBe(blockHash(c, 0, 16));
    const tailIndex = Math.floor(a.prefixTokens / 16);
    expect(blockHash(a, tailIndex, 16)).not.toBe(blockHash(b, tailIndex, 16));
  });

  it('different families and seeds never collide on token content', () => {
    expect(familyToken('chat', 0)).not.toBe(familyToken('code', 0));
    expect(requestToken(1, 0)).not.toBe(requestToken(2, 0));
    expect(familyToken('chat', 5)).not.toBe(familyToken('chat', 6));
  });

  it('prefix reuse is a contiguous full-block match after publishing', () => {
    const e = new SimulationEngine({ gpuCount: 1 });
    const cold = e.enqueue({ promptTokens: 256, outputTokens: 2, prefix: 'chat' });
    while (cold.status === 'waiting' || cold.status === 'prefill') e.step();
    const warm = e.enqueue({ promptTokens: 256, outputTokens: 2, prefix: 'chat' });
    const look = e.pools[0].lookupWithTiers(warm);
    expect(look.ids).toHaveLength(8);
    expect(look.missingHashes).toHaveLength(0);
    expect(look.tier).toBeNull();
    // Unique prompts share nothing.
    const unique = e.enqueue({ promptTokens: 256, outputTokens: 2, prefix: 'none' });
    expect(e.pools[0].match(unique)).toHaveLength(0);
  });
});

describe('KV watermark', () => {
  const run = (watermark: number) => {
    const e = new SimulationEngine({ gpuCount: 1, numBlocks: 64, kvWatermark: watermark, maxBatchSize: 8 });
    // (192+128)/16 = 20 blocks per request: 3 fit in 64 blocks, but only
    // 2 fit inside the 25% watermark's usable capacity of 48.
    e.burst(6, { promptTokens: 192, outputTokens: 128, prefix: 'none' });
    e.step();
    e.assertInvariants();
    return {
      active: e.requests.filter(r => r.status === 'prefill' || r.status === 'decode').length,
      watermarkBlocked: e.requests.some(r => r.reason.includes('watermark')),
    };
  };

  it('limits admission to the usable capacity and reports the watermark wait', () => {
    const r = run(0.25);
    expect(r.active).toBe(2);
    expect(r.watermarkBlocked).toBe(true);
  });

  it('watermark 0 admits more aggressively than watermark 0.25', () => {
    expect(run(0).active).toBeGreaterThan(run(0.25).active);
  });
});

describe('Multi-tier KV cache', () => {
  const tiered = () => new SimulationEngine({
    gpuCount: 1, numBlocks: 32, kvTiers: 'gpu-cpu', cpuKvBlocks: 64,
    cpuRestoreBandwidthGBps: 400, cpuRestoreLatencyMs: 0,
  });
  const evictAllCached = (e: SimulationEngine) => {
    // 512-token request fills the 32-block pool and forces every cached
    // prefix block through LRU eviction (demotion to the CPU tier).
    const big = e.enqueue({ promptTokens: 400, outputTokens: 112, prefix: 'none' });
    while (big.status !== 'completed') e.step();
  };

  it('demotes evicted prefix blocks to the CPU tier and restores them on demand', () => {
    const e = tiered();
    const cold = e.enqueue({ promptTokens: 256, outputTokens: 2, prefix: 'chat' });
    drain(e);
    evictAllCached(e);
    expect(e.pools[0].demoteBytes).toBeGreaterThan(0);
    const warm = e.enqueue({ promptTokens: 256, outputTokens: 2, prefix: 'chat' });
    let restored = false;
    for (let i = 0; i < 2000 && !restored; i++) {
      e.step();
      restored = e.metrics.cpuHitBlocks > 0;
    }
    expect(restored).toBe(true);
    drain(e);
    expect(warm.cachedTokens).toBe(128);
    expect(warm.generated).toBe(2);
    expect(e.metrics.restores).toBeGreaterThan(0);
    expect(e.metrics.tierBytesMoved).toBeGreaterThan(0);
    e.assertInvariants();
  });

  it('falls back to recompute when no tier holds the blocks', () => {
    const e = new SimulationEngine({ gpuCount: 1, numBlocks: 32, kvTiers: 'gpu-cpu', cpuKvBlocks: 0 });
    e.enqueue({ promptTokens: 256, outputTokens: 2, prefix: 'chat' });
    drain(e);
    evictAllCached(e);
    const warm = e.enqueue({ promptTokens: 256, outputTokens: 2, prefix: 'chat' });
    drain(e);
    expect(warm.cachedTokens).toBe(0);
    expect(e.metrics.recomputeBlocks).toBeGreaterThan(0);
    e.assertInvariants();
  });

  it('reports the interpretable KV size model', () => {
    // 2 (K+V) * 32 layers * 8 kvHeads * 128 headDim * 2 bytes = 131072 B/token.
    expect(bytesPerToken(normalizeConfig({ numLayers: 32, numKVHeads: 8, headDim: 128, bytesPerElement: 2 }))).toBe(131072);
  });
});
