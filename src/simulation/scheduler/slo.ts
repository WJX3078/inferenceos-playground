// SLO-aware scheduler.
//
// Each request carries (or inherits from config) a TTFT SLO in ms. The
// scheduler computes, for every waiting or preempted request, an
// interpretable urgency score:
//
//   deadline  = arrivedAt + sloTTFT
//   slack     = deadline - now                       (ms left before violation)
//   workLeft  = contextTarget - processed            (prompt tokens to prefill)
//   estMs     = ceil(workLeft / perIterationPrefill) * STEP_MS
//               (how long prefill will take if admitted now, at one chunk
//                per iteration bounded by the token budget)
//   urgency   = slack <= 0 ? ALREADY-VIOLATED : estMs / slack
//
// urgency > 1 predicts a TTFT miss; urgency <= 1 predicts it just makes it.
// Requests predicted to violate run first; already-violated requests run
// before everything (ordered by how far past their deadline they are), then
// by descending urgency, then arrival. Every number above is explainable —
// there are no magic weights.
//
// Preemption: a candidate may evict a victim with strictly lower urgency.

import type { Request } from '../types.ts';
import { STEP_MS, contextTarget } from '../types.ts';
import { byArrival, type SchedulingContext, type Scheduler } from './types.ts';

const VIOLATED = 1e9;

export function sloUrgency(r: Request, ctx: SchedulingContext, perIterationPrefill: number): number {
  const deadline = r.arrivedAt + (r.sloTTFT ?? ctx.config.sloTTFTms);
  const slack = deadline - ctx.now;
  if (slack <= 0) return VIOLATED - slack; // deeper violation -> larger
  const workLeft = Math.max(1, contextTarget(r) - r.processed);
  const estMs = Math.ceil(workLeft / Math.max(1, perIterationPrefill)) * STEP_MS;
  return estMs / slack;
}

export function makeSloScheduler(perIterationPrefill: () => number): Scheduler {
  const urgency = (r: Request, ctx: SchedulingContext) => sloUrgency(r, ctx, perIterationPrefill());
  const compare = (a: Request, b: Request, ctx: SchedulingContext) => {
    const ua = urgency(a, ctx), ub = urgency(b, ctx);
    // Descending urgency; the already-violated band (>= VIOLATED) sorts first
    // with the deepest violation on top.
    return ub - ua;
  };
  return {
    id: 'slo',
    label: 'SLO-aware',
    description: 'Urgency = estimated time to first token / slack until the TTFT SLO deadline. Predicted violations run first; explainable heuristic, no magic weights.',
    order: (candidates, ctx) => [...candidates].sort((a, b) => compare(a, b, ctx) || byArrival(a, b)),
    pickPrefill: (prefills, ctx) => [...prefills].sort((a, b) => compare(a, b, ctx) || byArrival(a, b))[0] ?? null,
    outranks: (candidate, victim, ctx) => compare(candidate, victim, ctx) < 0,
  };
}
