// Paged KV cache manager for one replica pool.
//
// - Physical blocks are allocated incrementally; the block table maps logical
//   to physical blocks (the vLLM paged-attention idea).
// - Prefix identity is CONTENT-based: every prompt is a deterministic synthetic
//   token stream; a full block's identity is the rolling hash
//   hash(parentHash, blockTokenIds). Only complete, immutable prefix blocks are
//   published into the content-addressed table and shared. Mutable tails are
//   never shared. Two requests only hit the cache if their token content
//   actually matches as a contiguous prefix.
// - Optional multi-tier hierarchy: evicted cached blocks are demoted
//   GPU -> CPU -> Remote (copy-on-demote, illustrative latencies/bandwidths).

import { fnv1a, hashHex } from './rng.ts';
import type { KVBlock, KvTierMode, PoolKind, Request } from './types.ts';

export interface TierConfig { mode: KvTierMode; cpuBlocks: number; remoteBlocks: number; blockBytes: number }

const familyBases = new Map<string, number>();
function familyBase(family: string): number {
  let base = familyBases.get(family);
  if (base === undefined) {
    base = fnv1a(0x9e3779b9, family.length);
    for (let i = 0; i < family.length; i++) base = fnv1a(base, family.charCodeAt(i));
    familyBases.set(family, base);
  }
  return base;
}

/** Deterministic synthetic token id for a shared-prefix family. */
export const familyToken = (family: string, index: number) => fnv1a(familyBase(family), index);
/** Deterministic synthetic token id for a request's unique tail. */
export const requestToken = (seed: number, index: number) => fnv1a(seed, 0x5bf03635, index);
export const tokenAt = (r: Request, index: number) =>
  index < r.prefixTokens ? familyToken(r.prefix, index) : requestToken(r.tokenSeed, index);

/** Rolling content hash of full block `i`; chained to block i-1 so only a true prefix matches. */
export function blockHash(r: Request, i: number, blockSize: number): string {
  let h = fnv1a(familyBase(r.prefix), 0x1f2e3d4c);
  for (let t = 0; t < (i + 1) * blockSize; t++) {
    if (t >= r.promptTokens) break;
    h = fnv1a(h, tokenAt(r, t));
  }
  return hashHex(h);
}

export class KVCacheManager {
  blocks: KVBlock[];
  evictions = 0;
  tierEvictions = 0;
  demoteBytes = 0;
  restoreBytes = 0;
  promotions = 0;
  readonly kind: PoolKind;
  private readonly tierMode: KvTierMode;
  private readonly cpuBlocks: number;
  private readonly remoteBlocks: number;
  private readonly blockBytes: number;
  /** content hash -> physical block id (immutable published prefix blocks) */
  private byHash = new Map<string, number>();
  /** demoted copies; Map preserves insertion order -> LRU via delete+set on touch */
  private cpu = new Map<string, number>();
  private remote = new Map<string, number>();

  readonly capacity: number;
  readonly blockSize: number;

  constructor(capacity: number, blockSize: number, kind: PoolKind = 'both', tiers: TierConfig | null = null) {
    this.capacity = capacity;
    this.blockSize = blockSize;
    this.kind = kind;
    this.tierMode = tiers?.mode ?? 'gpu';
    this.cpuBlocks = tiers?.cpuBlocks ?? 0;
    this.remoteBlocks = tiers?.remoteBlocks ?? 0;
    this.blockBytes = tiers?.blockBytes ?? blockSize * 131072;
    this.blocks = Array.from({ length: capacity }, (_, id) => ({
      id, owners: [], key: null, used: 0, lastUsed: 0, generation: 0,
    }));
  }

  get pinned() { return this.blocks.reduce((n, b) => n + (b.owners.length ? 1 : 0), 0); }
  get occupied() { return this.blocks.reduce((n, b) => n + (b.owners.length || b.key ? 1 : 0), 0); }
  get cachedCount() { return this.byHash.size; }

  /** GPU-only contiguous prefix match over published immutable blocks. */
  match(r: Request): number[] {
    const found: number[] = [];
    if (!r.prefixTokens) return found;
    for (let i = 0; i < Math.floor(r.prefixTokens / this.blockSize); i++) {
      const id = this.byHash.get(blockHash(r, i, this.blockSize));
      if (id === undefined) break;
      found.push(id);
    }
    return found;
  }

  /** GPU match with multi-tier fallback. `tier` names where ALL missing blocks live. */
  lookupWithTiers(r: Request): { ids: number[]; missingHashes: string[]; tier: 'cpu' | 'remote' | null } {
    const ids: number[] = [];
    if (!r.prefixTokens) return { ids, missingHashes: [], tier: null };
    const total = Math.floor(r.prefixTokens / this.blockSize);
    const hashes: string[] = [];
    for (let i = 0; i < total; i++) hashes.push(blockHash(r, i, this.blockSize));
    let split = 0;
    while (split < total) {
      const id = this.byHash.get(hashes[split]);
      if (id === undefined) break;
      ids.push(id);
      split++;
    }
    if (split === total) return { ids, missingHashes: [], tier: null };
    const missing = hashes.slice(split);
    if (this.tierMode !== 'gpu' && missing.every(h => this.cpu.has(h))) return { ids, missingHashes: missing, tier: 'cpu' };
    if (this.tierMode === 'gpu-cpu-remote' && missing.every(h => this.remote.has(h))) return { ids, missingHashes: missing, tier: 'remote' };
    return { ids, missingHashes: missing, tier: null };
  }

  attach(r: Request, ids: number[], now: number) {
    for (const id of ids) {
      const b = this.blocks[id];
      if (!b.owners.includes(r.id)) b.owners.push(r.id);
      b.lastUsed = now;
      r.blockTable.push(id);
    }
  }

  /** Allocate a fresh block for the request, evicting LRU cached blocks when needed. */
  private takeBlock(r: Request, now: number): KVBlock {
    const candidates = this.blocks.filter(b => b.owners.length === 0);
    candidates.sort((a, b) => Number(!!a.key) - Number(!!b.key) || a.lastUsed - b.lastUsed || a.id - b.id);
    const b = candidates[0];
    if (!b) throw new Error('KV reservation invariant violated');
    if (b.key) { this.evictCached(b, now); }
    b.key = null;
    b.used = 0;
    b.generation++;
    return b;
  }

  private evictCached(b: KVBlock, now: number) {
    const key = b.key;
    if (key) this.byHash.delete(key);
    // Demote through the hierarchy: GPU -> CPU -> Remote -> dropped.
    // A full tier cascades its LRU victim one level down instead of dropping it.
    if (key && this.tierMode !== 'gpu') {
      if (this.cpu.size < this.cpuBlocks) {
        this.cpu.set(key, now);
        this.demoteBytes += this.blockBytes;
      } else {
        const cpuVictim = this.lruOf(this.cpu);
        if (cpuVictim !== null) this.cpu.delete(cpuVictim);
        if (this.tierMode === 'gpu-cpu-remote') {
          if (this.remote.size < this.remoteBlocks) {
            if (cpuVictim !== null) this.remote.set(cpuVictim, now);
          } else {
            const remoteVictim = this.lruOf(this.remote);
            if (remoteVictim !== null) this.remote.delete(remoteVictim);
            if (cpuVictim !== null) this.remote.set(cpuVictim, now);
          }
        }
        this.tierEvictions++;
        this.cpu.set(key, now);
        this.demoteBytes += this.blockBytes;
      }
    }
    this.evictions++;
  }

  private lruOf(map: Map<string, number>): string | null {
    let victim: string | null = null;
    let time = Infinity;
    for (const [h, t] of map) if (t < time) { time = t; victim = h; }
    return victim;
  }

  ensure(r: Request, tokens: number, now: number) {
    const required = Math.ceil(tokens / this.blockSize);
    while (r.blockTable.length < required) {
      const b = this.takeBlock(r, now);
      this.attach(r, [b.id], now);
    }
    r.blockTable.forEach((id, i) => {
      this.blocks[id].used = Math.min(this.blockSize, Math.max(0, tokens - i * this.blockSize));
    });
  }

  /** Allocate brand-new blocks for a transferred sequence (disaggregated decode pool). */
  allocateFresh(r: Request, blocks: number, tokens: number, now: number) {
    for (let i = 0; i < blocks; i++) {
      const b = this.takeBlock(r, now);
      this.attach(r, [b.id], now);
    }
    r.blockTable.forEach((id, i) => {
      this.blocks[id].used = Math.min(this.blockSize, Math.max(0, tokens - i * this.blockSize));
    });
  }

  /** Publish full prefix blocks into the content-addressed table. */
  publish(r: Request) {
    const total = Math.floor(r.prefixTokens / this.blockSize);
    for (let i = 0; i < total; i++) {
      const hash = blockHash(r, i, this.blockSize);
      const b = this.blocks[r.blockTable[i]];
      // Concurrent cold prefills can compute duplicate pages; keep one canonical copy.
      if (b && b.used === this.blockSize && !this.byHash.has(hash)) {
        b.key = hash;
        this.byHash.set(hash, b.id);
      }
    }
  }

  /** Restore demoted blocks back into the GPU pool after a tier hit. */
  restoreBlocks(hashes: string[], now: number) {
    for (const hash of hashes) {
      if (this.byHash.has(hash)) continue;
      const candidates = this.blocks.filter(b => b.owners.length === 0);
      candidates.sort((a, b) => Number(!!a.key) - Number(!!b.key) || a.lastUsed - b.lastUsed || a.id - b.id);
      const b = candidates[0];
      if (!b) throw new Error('restore failed: no free block');
      if (b.key) this.evictCached(b, now);
      b.key = hash;
      b.used = this.blockSize;
      b.lastUsed = now;
      b.generation++;
      this.byHash.set(hash, b.id);
      this.restoreBytes += this.blockBytes;
      this.promotions++;
    }
  }

  release(r: Request, keepPrefix: boolean, now: number) {
    for (const id of r.blockTable) {
      const b = this.blocks[id];
      b.owners = b.owners.filter(owner => owner !== r.id);
      b.lastUsed = now;
      if (!b.owners.length && (!keepPrefix || !b.key)) {
        if (b.key) this.byHash.delete(b.key);
        b.key = null; b.used = 0;
      }
    }
  }

  clearUnused() {
    for (const b of this.blocks) {
      if (!b.owners.length) {
        if (b.key) this.byHash.delete(b.key);
        b.key = null; b.used = 0;
      }
    }
    this.cpu.clear();
    this.remote.clear();
  }

  tierDepth() { return this.tierMode === 'gpu' ? 1 : this.tierMode === 'gpu-cpu' ? 2 : 3; }
}
