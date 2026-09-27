import { describe, expect, it } from 'vitest';
import { canTransition, TRANSITIONS, transitionRequest } from './runtime/lifecycle';
import { SimulationEngine } from './engine';
import type { Phase, Request } from './types';
import { normalizeConfig } from './types';

const mk = (over: Partial<Request>): Request => ({
  promptTokens: 100, outputTokens: 10, prefix: 'none', id: 'R000', status: 'waiting',
  arrivedAt: 0, priority: 'normal', sloTTFT: 500, sloTPOT: 50, tokenSeed: 1,
  group: null, prefillGroup: null, decodeGroup: null, processed: 0, generated: 0,
  cachedTokens: 0, prefixTokens: 0, blockTable: [], compute: 0, reason: '', spans: [],
  preemptions: 0, recomputedTokens: 0, transfer: null, pendingRestoreCount: 0, tierHit: null,
  starvedSince: null, observed: undefined, resumeTarget: null, speculative: null,
  ...over,
});

describe('Request state machine', () => {
  it('declares exactly the legal transitions', () => {
    expect(TRANSITIONS.waiting).toEqual(['prefill', 'rejected', 'cancelled']);
    expect(TRANSITIONS.prefill).toEqual(['decode', 'transfer_wait', 'preempted', 'cancelled']);
    expect(TRANSITIONS.decode).toEqual(['completed', 'preempted', 'cancelled']);
    expect(TRANSITIONS.preempted).toEqual(['prefill', 'cancelled']);
    expect(TRANSITIONS.transfer_wait).toEqual(['transferring', 'cancelled']);
    expect(TRANSITIONS.transferring).toEqual(['decode_wait', 'cancelled']);
    expect(TRANSITIONS.decode_wait).toEqual(['decode', 'cancelled']);
    for (const t of ['completed', 'rejected', 'cancelled'] as Phase[]) {
      expect(TRANSITIONS[t]).toEqual([]); // terminal states are absorbing
    }
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('waiting', 'decode')).toBe(false);
    expect(canTransition('decode', 'waiting')).toBe(false);
    expect(canTransition('completed', 'decode')).toBe(false);
    expect(canTransition('transfer_wait', 'decode')).toBe(false);
    expect(canTransition('cancelled', 'waiting')).toBe(false);
    expect(() => transitionRequest(mk({ status: 'waiting' }), 'decode')).toThrow(/Illegal request transition/);
    expect(() => transitionRequest(mk({ status: 'completed' }), 'decode')).toThrow(/Illegal request transition/);
  });

  it('accepts the full disaggregated lifecycle in order', () => {
    const r = mk({ status: 'waiting' });
    const path: Phase[] = ['prefill', 'transfer_wait', 'transferring', 'decode_wait', 'decode', 'completed'];
    for (const next of path) expect(() => transitionRequest(r, next)).not.toThrow();
    expect(r.status).toBe('completed');
  });

  it('supports cancel from every live state and preemption round-trips', () => {
    for (const live of ['waiting', 'prefill', 'decode', 'preempted', 'transfer_wait', 'transferring', 'decode_wait'] as Phase[]) {
      const r = mk({ status: live });
      expect(() => transitionRequest(r, 'cancelled')).not.toThrow();
    }
    const r = mk({ status: 'prefill' });
    transitionRequest(r, 'preempted');
    transitionRequest(r, 'prefill'); // resume via recompute
    expect(r.status).toBe('prefill');
  });

  it('is idempotent for same-state no-ops', () => {
    const r = mk({ status: 'prefill' });
    expect(() => transitionRequest(r, 'prefill')).not.toThrow();
  });

  it('the engine never leaves the legal graph (stress crawl)', () => {
    const e = new SimulationEngine({ gpuCount: 2, numBlocks: 64, maxBatchSize: 8, schedulerPolicy: 'priority', preemptionMode: 'cost-aware' });
    e.burst(20, { promptTokens: 256, outputTokens: 64, prefix: 'chat' });
    let transitions = 0;
    const seen = new Map<string, string>();
    for (let i = 0; i < 1200; i++) {
      for (const r of e.requests) {
        const prev = seen.get(r.id);
        if (prev !== undefined && prev !== r.status) {
          transitions++;
          expect(canTransition(prev as Phase, r.status), `${r.id}: ${prev} -> ${r.status}`).toBe(true);
        }
        seen.set(r.id, r.status);
      }
      e.step();
    }
    expect(transitions).toBeGreaterThan(50);
  });

  it('exposes validated config for the new knobs', () => {
    const c = normalizeConfig({ preemptionMode: 'recompute', preemptionCooldownMs: -5, starvationThresholdMs: 999999, transferSchedulingPolicy: 'bogus' as never, maxPendingDecodeRequests: -1 });
    expect(c.preemptionMode).toBe('cost-aware'); // legacy alias
    expect(c.preemptionCooldownMs).toBe(0);
    expect(c.starvationThresholdMs).toBe(600000);
    expect(c.transferSchedulingPolicy).toBe('fair-share');
    expect(c.maxPendingDecodeRequests).toBe(0);
  });
});
