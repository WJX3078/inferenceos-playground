import type { Scheduler } from './types.ts';
import { fcfsScheduler } from './fcfs.ts';
import { sjfScheduler } from './sjf.ts';
import { priorityScheduler } from './priority.ts';
import { makeSloScheduler } from './slo.ts';
import type { SchedulerPolicy } from '../types.ts';

export const SCHEDULER_IDS: SchedulerPolicy[] = ['fcfs', 'sjf', 'priority', 'slo'];

/** The SLO scheduler needs the effective per-iteration prefill capacity. */
export function createScheduler(policy: SchedulerPolicy, prefillCapacity: () => number): Scheduler {
  switch (policy) {
    case 'sjf': return sjfScheduler;
    case 'priority': return priorityScheduler;
    case 'slo': return makeSloScheduler(prefillCapacity);
    default: return fcfsScheduler;
  }
}

export const schedulerById = (policy: SchedulerPolicy, prefillCapacity: () => number): Scheduler =>
  createScheduler(policy, prefillCapacity);

export type { Scheduler } from './types.ts';
export { fcfsScheduler, sjfScheduler, priorityScheduler, makeSloScheduler };
