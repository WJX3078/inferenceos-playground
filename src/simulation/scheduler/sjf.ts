// SJF / Shortest Remaining Work.
//
// Estimated remaining work in tokens:
//   remaining = (contextTarget - processed) + (outputTokens - generated)
// where contextTarget = promptTokens + generated (a preempted request must
// recompute its generated suffix as prefill, so that work counts too).
//
// Shortest remaining work bounds average latency (SJF is optimal for mean
// flow time on a single machine) but starves long requests under sustained
// short load. Arrival time + id break ties deterministically.
//
// Preemption: a candidate may evict a victim with strictly more remaining work.

import { makeBase, remainingWork } from './types.ts';

export const sjfScheduler = makeBase(
  'sjf',
  'SJF / SRW',
  'Shortest remaining work first: (remaining prompt + remaining output) tokens, arrival time breaks ties.',
  (a, b) => remainingWork(a) - remainingWork(b),
);
