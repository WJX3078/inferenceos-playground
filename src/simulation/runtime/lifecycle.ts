// Explicit request state machine.
//
// Every request status change goes through transitionRequest(); illegal
// transitions throw instead of silently producing unreachable states. The
// table below is the single source of truth (mirrored by docs/scheduler.md
// and asserted by tests).

import type { Phase, Request } from '../types.ts';

export const TRANSITIONS: Record<Phase, Phase[]> = {
  waiting: ['prefill', 'rejected', 'cancelled'],
  prefill: ['decode', 'transfer_wait', 'preempted', 'cancelled'],
  decode: ['completed', 'preempted', 'cancelled'],
  preempted: ['prefill', 'cancelled'],
  transfer_wait: ['transferring', 'cancelled'],
  transferring: ['decode_wait', 'cancelled'],
  decode_wait: ['decode', 'cancelled'],
  completed: [],
  rejected: [],
  cancelled: [],
};

/** True when a status change is legal (cancel from any live state is legal). */
export function canTransition(from: Phase, to: Phase): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Move a request to `next`, throwing on an illegal transition. */
export function transitionRequest(r: Request, next: Phase, detail?: string): void {
  if (r.status === next) return; // idempotent no-op (e.g. re-setting the same phase)
  if (!canTransition(r.status, next)) {
    throw new Error(`Illegal request transition ${r.status} -> ${next} for ${r.id}${detail ? ` (${detail})` : ''}`);
  }
  r.status = next;
}

/** Initial statuses set at creation (outside the transition table). */
export const INITIAL_PHASES: Phase[] = ['waiting', 'rejected'];
