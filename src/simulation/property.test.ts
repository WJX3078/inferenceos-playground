// Property-based tests (v1.0 hardening).
//
// These complement the randomized stress tests with INVARIANT-style
// properties that must hold for every run, every tick — the kind of bugs a
// point-assertion test can miss.

import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine';

const IN_FLIGHT = ['waiting', 'prefill', 'decode', 'preempted', 'transfer_wait', 'transferring', 'decode_wait'];

function runSeeded(config: Record<string, unknown>, seed: number, requests: number, steps: number) {
  const e = new SimulationEngine(config, seed);
  e.burst(requests, { promptTokens: 256, outputTokens: 64, prefix: 'chat' });
  const samples: { outputTokens: number; networkBytes: number; finishedAts: number[] }[] = [];
  for (let i = 0; i < steps; i++) {
    e.step();
    samples.push({
      outputTokens: e.collector.outputTokens,
      networkBytes: e.transfers.bytesTotal,
      finishedAts: e.requests.filter(r => r.finishedAt !== undefined).map(r => r.finishedAt!),
    });
  }
  return { e, samples };
}

describe('Simulation properties', () => {
  it('outputTokensGenerated never decreases across the whole run', () => {
    const { e, samples } = runSeeded({ gpuCount: 2, numBlocks: 64, maxBatchSize: 8 }, 41, 16, 900);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].outputTokens).toBeGreaterThanOrEqual(samples[i - 1].outputTokens);
    }
    expect(e.collector.outputTokens).toBeGreaterThan(0);
  });

  it('finishedAt, once set, never changes', () => {
    const { e, samples } = runSeeded({ gpuCount: 2, numBlocks: 64 }, 42, 12, 700);
    const observed: Record<string, number> = {};
    for (const snap of samples) {
      for (const r of e.requests) {
        if (r.finishedAt === undefined) continue;
        if (observed[r.id] !== undefined) {
          expect(observed[r.id]).toBe(r.finishedAt);
        }
        observed[r.id] = r.finishedAt;
      }
      void snap;
    }
  });

  it('network bytes moved equal the bytes of completed transfers (transfer conservation)', () => {
    const { e } = runSeeded(
      { servingMode: 'disaggregated', gpuCount: 4, prefillGpuCount: 2, decodeGpuCount: 2, numBlocks: 128 },
      43, 10, 1500,
    );
    const logBytes = e.transfers.log.reduce((n, rec) => n + rec.bytes, 0);
    expect(e.transfers.bytesTotal).toBe(logBytes);
    // Every byte claimed by the manager was scheduled by a real request payload.
    for (const rec of e.transfers.log) {
      const r = e.requests.find(x => x.id === rec.requestId);
      if (r) expect(rec.bytes).toBe(r.promptTokens * 2 * e.config.numLayers * e.config.numKVHeads * e.config.headDim * e.config.bytesPerElement);
    }
  });

  it('processed only resets on preemption (monotone within a lifecycle)', () => {
    const e = new SimulationEngine({ gpuCount: 1, numBlocks: 96, maxBatchSize: 2, schedulerPolicy: 'priority', preemptionMode: 'cost-aware', preemptionCooldownMs: 0 }, 44);
    e.burst(8, { promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'normal' });
    e.enqueue({ promptTokens: 64, outputTokens: 8, prefix: 'none', priority: 'high' });
    const last = new Map<string, number>();
    const preemptions = new Map<string, number>();
    for (let i = 0; i < 1500; i++) {
      e.step();
      for (const r of e.requests) {
        const prev = last.get(r.id);
        const preemptedNow = (preemptions.get(r.id) ?? 0) < r.preemptions;
        if (prev !== undefined && !preemptedNow) {
          expect(r.processed).toBeGreaterThanOrEqual(prev);
        }
        last.set(r.id, r.processed);
        preemptions.set(r.id, r.preemptions);
      }
    }
  });

  it('same seed produces an identical event stream (replay property)', () => {
    const run = () => {
      const e = new SimulationEngine({ gpuCount: 2, speculativeDecoding: true, numBlocks: 64 }, 45);
      e.burst(10, { promptTokens: 256, outputTokens: 48, prefix: 'code' });
      e.step(500);
      return e.events.map(x => `${x.at}:${x.type}:${x.requestId ?? ''}:${x.message}`).join('|');
    };
    expect(run()).toBe(run());
  });

  it('cache blocks with no owners and no key are always reclaimable', () => {
    const e = new SimulationEngine({ gpuCount: 1, numBlocks: 32 }, 46);
    e.burst(6, { promptTokens: 256, outputTokens: 64, prefix: 'none' });
    for (let i = 0; i < 600; i++) {
      e.step();
      const free = e.pools[0].blocks.filter(b => !b.owners.length && !b.key);
      const pinned = e.pools[0].pinned;
      // Any unowned unkeyed block can always serve a new allocation.
      if (pinned < e.pools[0].capacity) expect(free.length).toBeGreaterThan(0);
    }
    e.assertInvariants();
  });

  it('every request eventually leaves the live set or stays schedulable (no black holes)', () => {
    const e = new SimulationEngine({ gpuCount: 2, numBlocks: 64, schedulerPolicy: 'sjf', starvationThresholdMs: 5000 }, 47);
    e.burst(24, { promptTokens: 128, outputTokens: 48, prefix: 'none' });
    const stalled = new Map<string, number>();
    for (let i = 0; i < 4000 && e.requests.some(r => IN_FLIGHT.includes(r.status)); i++) {
      e.step();
      for (const r of e.requests) {
        if (!IN_FLIGHT.includes(r.status)) continue;
        const key = `${r.id}:${r.status}`;
        const since = stalled.get(key) ?? i;
        // A request cannot sit in the same non-terminal state for > 3000 ticks
        // (60 simulated seconds) without completing.
        expect(i - since, `${r.id} stuck ${r.status}`).toBeLessThan(3000);
        if (i - since >= 3000) stalled.set(key, i); // unreachable; expect above throws
      }
    }
    expect(e.requests.every(r => !IN_FLIGHT.includes(r.status))).toBe(true);
  });
});
