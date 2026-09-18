import type { Allocation, Config, Request } from './types';

export function effectivePriority(r: Request, now: number) {
  return { LOW: 0, NORMAL: 1, HIGH: 2 }[r.priority]
    + Math.floor((r.queueMs + (r.status === 'waiting' ? Math.max(0, now - r.waitingSince) : 0)) / 2000);
}
/** Pure token allocation. Admission/reservations and execution remain in the engine. */
export function scheduleTokens(batch: Request[], config: Config, cursor: { decode: number; prefill: number }, ready: Set<string>) {
  let remaining = config.maxNumBatchedTokens;
  const scheduled: Allocation[] = [];
  const skipped: { requestId: string; reason: string; priority: string }[] = [];
  const rotate = (rows: Request[], nextId: number) => {
    rows.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    const next = rows.findIndex(r => Number(r.id.slice(1)) >= nextId);
    const offset = Math.max(0, next);
    return [...rows.slice(offset), ...rows.slice(0, offset)];
  };
  const ordered = [...rotate(batch.filter(r => r.status === 'decode'), cursor.decode), ...rotate(batch.filter(r => r.status === 'prefill'), cursor.prefill)];
  for (const r of ordered) {
    const priority = r.priority;
    if (r.status === 'decode' && !ready.has(r.id)) {
      skipped.push({ requestId: r.id, reason: 'Decode compute in progress', priority });
      continue;
    }
    const demand = r.status === 'prefill'
      ? Math.min(config.maxPrefillTokensPerStep, (r.recomputing ? r.recomputeUntil : r.promptTokens) - r.processed)
      : Math.min(config.speculativeDecoding ? 5 : 1, r.outputTokens - r.generated);
    const tokens = Math.min(remaining, demand);
    if (tokens > 0) {
      scheduled.push({ requestId: r.id, phase: r.status as 'prefill' | 'decode', tokens, priority });
      remaining -= tokens;
    } else skipped.push({ requestId: r.id, reason: 'Token budget exhausted', priority });
  }
  const nextCursor = { ...cursor };
  for (const phase of ['decode', 'prefill'] as const) {
    const rows = ordered.filter(r => r.status === phase);
    const last = scheduled.filter(a => a.phase === phase).at(-1);
    if (last) nextCursor[phase] = Number(rows[(rows.findIndex(r => r.id === last.requestId) + 1) % rows.length].id.slice(1));
  }
  return { scheduled, skipped, remaining, nextCursor };
}
