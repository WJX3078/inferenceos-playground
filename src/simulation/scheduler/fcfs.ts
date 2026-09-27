// FCFS: strict arrival order. This is the classic vLLM default policy.
// Preemption: a candidate may only evict a victim that arrived strictly later.

import { makeBase } from './types.ts';

export const fcfsScheduler = makeBase(
  'fcfs',
  'FCFS',
  'First come, first served by arrival time; request id breaks ties. No request is reordered.',
  (a, b) => a.arrivedAt - b.arrivedAt,
);
