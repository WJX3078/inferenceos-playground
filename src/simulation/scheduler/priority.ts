// Priority scheduler.
//
// Requests carry a class (low < normal < high). Higher classes are always
// admitted first; equal classes fall back to arrival order. Without
// preemption this can starve low-priority requests (see the
// priority-inversion scenario); with recompute preemption a strictly higher
// class may evict a running lower-class request under KV pressure.
//
// Preemption rule: candidate.priorityRank > victim.priorityRank (strict).

import type { Request } from '../types.ts';
import { makeBase, priorityRankOf } from './types.ts';

export const priorityScheduler = {
  ...makeBase(
    'priority',
    'Priority',
    'High > normal > low priority class first, then arrival order. Strictly higher classes may preempt lower ones under KV pressure.',
    (a, b) => priorityRankOf(b) - priorityRankOf(a),
  ),
  outranks: (candidate: Request, victim: Request) => priorityRankOf(candidate) > priorityRankOf(victim),
};
