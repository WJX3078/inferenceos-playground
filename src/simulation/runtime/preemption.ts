// Cost-aware recompute preemption.
//
// Modes (config.preemptionMode):
// - 'none': no preemption.
// - 'prefill-only': only requests still in prefill may be evicted (the safe
//   default for disaggregated serving, where decode-pool KV is committed).
// - 'cost-aware' (legacy 'recompute' normalizes here): any running request on
//   an eligible pool may be evicted, choosing the CHEAPEST victim.
//
// Victim cost (documented heuristic, illustrative policy — not vLLM behavior):
//   recomputeCost(v) = contextTarget(v) - v.cachedTokens
// i.e. the tokens a resume would recompute (prompt + generated suffix minus
// the prefix-cache hit the victim enjoyed). Preempting a request that just
// started prefill is cheap; preempting one that has decoded for seconds is
// expensive — the scheduler therefore prefers young, small victims.
//
// Anti-storm guarantees (all deterministic, no wall clock):
// - Minimum residency: a victim must have run >= MIN_RESIDENCY_MS before it
//   can be evicted (no preempting a request the instant it is admitted).
// - Cooldown: engine-wide, at most one preemption per
//   config.preemptionCooldownMs of simulated time.
// - Strict ordering: a candidate must STRICTLY outrank the victim in the
//   scheduler's total order, so mutual preemption cycles are impossible.

import type { Config, Phase, Request } from '../types.ts';
import { contextTarget } from '../types.ts';
import { transitionRequest } from './lifecycle.ts';
import type { SchedulingContext, Scheduler } from '../scheduler/types.ts';

export const MIN_RESIDENCY_MS = 200;

export interface PreemptionCandidatePool {
  p: number;
  kind: 'both' | 'prefill' | 'decode';
  batch: Request[];
  staticBusy: boolean;
  fits: boolean;
}

/** Narrow view of the engine the controller is allowed to touch. */
export interface PreemptionHost {
  config: Config;
  now: number;
  scheduler: Scheduler;
  collector: { preemptions: number };
  event: (type: string, message: string, requestId?: string) => void;
  updateWorkers: () => void;
  releaseVictim: (victim: Request) => void;
  ctx: () => SchedulingContext;
}

export class PreemptionController {
  lastPreemptAt = -Infinity;
  private host: PreemptionHost;

  constructor(host: PreemptionHost) {
    this.host = host;
  }

  private get mode(): 'none' | 'prefill-only' | 'cost-aware' {
    const m = this.host.config.preemptionMode;
    return m === 'prefill-only' ? 'prefill-only' : m === 'cost-aware' || m === 'recompute' ? 'cost-aware' : 'none';
  }

  /** Estimated tokens to recompute if `v` is evicted now. */
  recomputeCost(v: Request): number {
    return Math.max(0, contextTarget(v) - v.cachedTokens);
  }

  /** Try to evict one victim for `candidate`; returns the victim or null. */
  tryPreempt(candidate: Request, candidates: PreemptionCandidatePool[]): Request | null {
    const mode = this.mode;
    if (mode === 'none') return null;
    if (this.host.now - this.lastPreemptAt < this.host.config.preemptionCooldownMs) return null;
    for (const t of candidates) {
      if (t.kind === 'decode') continue; // disaggregated decode KV is committed; never preempted
      if (t.staticBusy) continue;
      let victims = t.batch.filter(v => this.host.scheduler.outranks(candidate, v, this.host.ctx()));
      if (mode === 'prefill-only') victims = victims.filter(v => v.status === 'prefill');
      victims = victims.filter(v => this.host.now - (v.admittedAt ?? this.host.now) >= MIN_RESIDENCY_MS);
      if (!victims.length) continue;
      const victim = mode === 'cost-aware'
        ? [...victims].sort((a, b) =>
            this.recomputeCost(a) - this.recomputeCost(b)
            || b.arrivedAt - a.arrivedAt
            || b.id.localeCompare(a.id))[0]
        : this.host.scheduler.order(victims, this.host.ctx()).at(-1)!;
      this.preempt(victim, candidate);
      return victim;
    }
    return null;
  }

  private preempt(victim: Request, by: Request) {
    const cost = this.recomputeCost(victim);
    this.host.releaseVictim(victim);
    transitionRequest(victim, 'preempted' as Phase, `preempted by ${by.id}`);
    victim.preemptions++;
    this.lastPreemptAt = this.host.now;
    this.host.collector.preemptions++;
    this.host.event('preempt',
      `preempted by ${by.id} (${this.host.scheduler.id}); ~${cost} tokens will be recomputed`,
      victim.id);
    this.host.updateWorkers();
  }
}
