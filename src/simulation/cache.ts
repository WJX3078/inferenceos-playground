import type { KVBlock, PrefixBlock, Request } from './types';

export function tokenIdentity(promptTokens: number, prefix: string, serial: number, explicit?: readonly number[]): readonly number[] {
  if (explicit && (explicit.length !== promptTokens || explicit.some(t => !Number.isSafeInteger(t)))) throw new Error('Token identity must contain one integer per prompt token');
  if (explicit) return Object.freeze([...explicit]);
  const shared = prefix === 'none' ? 0 : Math.min(128, Math.floor(promptTokens / 2));
  const family = { chat: 10000, code: 20000, docs: 30000 }[prefix] ?? 0;
  return Object.freeze(Array.from({ length: promptTokens }, (_, i) => i < shared ? family + i : 100000 + serial * 8192 + i));
}
export function hashBlock(parent: string, tokens: readonly number[]): string {
  let a = 2166136261, b = 2246822519;
  for (const char of `${parent}:${tokens.join(',')}`) {
    a = Math.imul(a ^ char.charCodeAt(0), 16777619);
    b = Math.imul(b ^ char.charCodeAt(0), 3266489917);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
const immutableChains = new WeakMap<readonly number[], Map<number, readonly PrefixBlock[]>>();
export function blockChain(tokens: readonly number[], blockSize: number): readonly PrefixBlock[] {
  const cached = immutableChains.get(tokens)?.get(blockSize);
  if (cached) return cached;
  let parentHash = 'root';
  const chain = Object.freeze(Array.from({ length: Math.floor(tokens.length / blockSize) }, (_, index) => {
    const start = index * blockSize, end = start + blockSize;
    const hash = hashBlock(parentHash, tokens.slice(start, end));
    const block = Object.freeze({ index, hash, parentHash, start, end });
    parentHash = hash;
    return block;
  }));
  if (Object.isFrozen(tokens)) {
    const sizes = immutableChains.get(tokens) ?? new Map();
    sizes.set(blockSize, chain); immutableChains.set(tokens, sizes);
  }
  return chain;
}

export class KVCacheManager {
  blocks: KVBlock[];
  evictions = 0;
  constructor(readonly capacity: number, readonly blockSize: number) {
    this.blocks = Array.from({ length: capacity }, (_, id) => ({
      id, owners: [], key: null, used: 0, lastUsed: 0, generation: 0, identity: null, logicalIndex: null,
    }));
  }
  get pinned() { return this.blocks.filter(b => b.owners.length).length; }
  get occupied() { return this.blocks.filter(b => b.owners.length || b.key).length; }
  key(r: Request, index: number) { return r.prefixChain[index].hash; }
  matches(b: KVBlock, r: Request, index: number) {
    // Hash lookup plus complete prefix identity validation avoids false reuse on collisions.
    return b.key === this.key(r, index) && b.logicalIndex === index
      && b.identity !== null && b.identity.slice(0, (index + 1) * this.blockSize).every((t, i) => t === r.tokenIds[i]);
  }
  match(r: Request): number[] {
    const found: number[] = [];
    for (let i = 0; i < r.prefixChain.length; i++) {
      const block = this.blocks.find(b => this.matches(b, r, i));
      if (!block) break;
      found.push(block.id);
    }
    return found;
  }
  attach(r: Request, ids: number[], now: number) {
    for (const id of ids) {
      const b = this.blocks[id];
      if (!b.owners.includes(r.id)) b.owners.push(r.id);
      b.lastUsed = now;
      r.blockTable.push(id);
    }
  }
  ensure(r: Request, tokens: number, now: number) {
    const required = Math.ceil(tokens / this.blockSize);
    while (r.blockTable.length < required) {
      const candidates = this.blocks.filter(b => b.owners.length === 0);
      const b = candidates.sort((a, b) => Number(!!a.key) - Number(!!b.key) || a.lastUsed - b.lastUsed || a.id - b.id)[0];
      if (!b) throw new Error('KV reservation invariant violated');
      if (b.key) this.evictions++;
      b.key = null;
      b.identity = null; b.logicalIndex = null;
      b.used = 0;
      b.generation++;
      this.attach(r, [b.id], now);
    }
    r.blockTable.forEach((id, i) => {
      const b = this.blocks[id], used = Math.min(this.blockSize, Math.max(0, tokens - i * this.blockSize));
      if (b.key && b.used !== used) throw new Error('Attempt to mutate immutable prefix');
      b.used = used;
    });
  }
  publish(r: Request) {
    for (let i = 0; i < r.prefixChain.length; i++) {
      const key = this.key(r, i);
      const b = this.blocks[r.blockTable[i]];
      // Concurrent cold prefills can compute duplicate pages; keep one canonical copy.
      if (b && b.used === this.blockSize && !this.blocks.some(x => this.matches(x, r, i))) {
        b.key = key; b.identity = r.tokenIds; b.logicalIndex = i;
      }
    }
  }
  release(r: Request, keepPrefix: boolean, now: number) {
    for (const id of r.blockTable) {
      const b = this.blocks[id];
      b.owners = b.owners.filter(owner => owner !== r.id);
      b.lastUsed = now;
      if (!b.owners.length && (!keepPrefix || !b.key)) { b.key = null; b.used = 0; b.identity = null; b.logicalIndex = null; }
    }
  }
  clearUnused() {
    for (const b of this.blocks) if (!b.owners.length) { b.key = null; b.used = 0; b.identity = null; b.logicalIndex = null; }
  }
}
