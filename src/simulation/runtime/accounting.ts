// Shared resource-accounting functions (pure).
//
// These are the single source of truth for "who holds what on which pool".
// The engine, admission controller and executor all use them; the invariant
// checker uses the same functions so tests verify exactly what runs.

import type { Config, PoolKind, Request } from '../types.ts';
import { blocksFor, debtBlocks, holding, reservedTokens } from '../types.ts';
import type { KVCacheManager } from '../cache.ts';

/** Requests that hold KV blocks (or a reservation) on pool p. */
export function poolRequests(requests: Request[], poolKinds: PoolKind[], p: number): Request[] {
  const kind = poolKinds[p];
  return requests.filter(r => {
    if (kind === 'both') return r.group === p && holding(r);
    if (kind === 'prefill') return r.prefillGroup === p
      && (r.status === 'prefill' || r.status === 'transfer_wait' || r.status === 'transferring');
    return r.decodeGroup === p && holding(r);
  });
}

/** Unallocated reservation blocks a request holds on pool p.
 *  Transfer-phase requests keep their prompt blocks on the prefill pool, so
 *  the decode pool must still reserve their FULL prompt+output footprint. */
export function debtOnPool(config: Config, poolKinds: PoolKind[], r: Request, p: number): number {
  const kind = poolKinds[p];
  if (kind === 'decode' && (r.status === 'transfer_wait' || r.status === 'transferring')) {
    return blocksFor(reservedTokens(r, 'decode'), config.blockSize);
  }
  return Math.max(0, debtBlocks(r, kind, config.blockSize));
}

/** Sum of unallocated reservation blocks held on pool p. */
export function poolDebt(config: Config, requests: Request[], poolKinds: PoolKind[], p: number): number {
  let debt = 0;
  for (const r of poolRequests(requests, poolKinds, p)) debt += debtOnPool(config, poolKinds, r, p);
  return debt;
}

/** Capacity usable for admission after the KV watermark reserve. */
export function usableCapacity(config: Config, pool: KVCacheManager): number {
  return pool.capacity - Math.floor(pool.capacity * config.kvWatermark);
}

/** Requests whose KV blocks physically live on pool p. */
export function poolBlockOwners(requests: Request[], servingMode: Config['servingMode'], p: number): Request[] {
  return requests.filter(r => ownerPoolOf(r, servingMode) === p);
}

/** Index of the pool where a request currently holds KV blocks (null = none). */
export function ownerPoolOf(r: Request, servingMode: Config['servingMode']): number | null {
  if (r.status === 'completed' || r.status === 'cancelled' || r.status === 'rejected'
    || r.status === 'preempted' || r.status === 'waiting') return null;
  if (servingMode === 'monolithic') return r.group;
  return r.status === 'decode' || r.status === 'decode_wait' ? r.decodeGroup : r.prefillGroup;
}
