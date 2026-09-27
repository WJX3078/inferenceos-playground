// Scheduler policy contract. Policies only ORDER work; the engine owns
// feasibility (KV reservation, batch slots, token budget). This mirrors the
// vLLM split between a scheduling policy and the core loop's resource checks.

import type { Config, Priority, Request } from '../types.ts';
import { contextTarget, priorityRank } from '../types.ts';

export interface SchedulingContext {
  config: Config;
  now: number;
}

export interface Scheduler {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Admission order for waiting/preempted requests (most urgent first). */
  order(candidates: Request[], ctx: SchedulingContext): Request[];
  /** Which prefilling sequence advances its chunk this iteration (one per replica). */
  pickPrefill(prefills: Request[], ctx: SchedulingContext): Request | null;
  /** True when `candidate` may preempt the running `victim` (strict total order — no cycles). */
  outranks(candidate: Request, victim: Request, ctx: SchedulingContext): boolean;
}

/** Stable tie-break: arrival time, then request id. */
export const byArrival = (a: Request, b: Request) =>
  a.arrivedAt - b.arrivedAt || a.id.localeCompare(b.id);

export const remainingWork = (r: Request) =>
  contextTarget(r) - r.processed + (r.outputTokens - r.generated);

export function makeBase(id: string, label: string, description: string,
  compare: (a: Request, b: Request, ctx: SchedulingContext) => number): Scheduler {
  return {
    id, label, description,
    order: (candidates, ctx) => [...candidates].sort((a, b) => compare(a, b, ctx) || byArrival(a, b)),
    pickPrefill: (prefills, ctx) =>
      [...prefills].sort((a, b) => compare(a, b, ctx) || byArrival(a, b))[0] ?? null,
    outranks: (candidate, victim, ctx) => compare(candidate, victim, ctx) < 0,
  };
}

export const priorityRankOf = (r: Request): number => priorityRank(r.priority ?? 'normal');
export const rankName = (p: Priority) => p;
