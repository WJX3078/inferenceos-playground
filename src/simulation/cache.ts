import type { KVBlock, Request } from './types';

export class KVCacheManager {
  blocks: KVBlock[];
  evictions = 0;
  constructor(readonly capacity: number, readonly blockSize: number) {
    this.blocks = Array.from({ length: capacity }, (_, id) => ({
      id, owners: [], key: null, used: 0, lastUsed: 0, generation: 0,
    }));
  }
  get pinned() { return this.blocks.filter(b => b.owners.length).length; }
  get occupied() { return this.blocks.filter(b => b.owners.length || b.key).length; }
  key(r: Request, index: number) { return `${r.prefix}:${index}`; }
  match(r: Request): number[] {
    const found: number[] = [];
    for (let i = 0; i < Math.floor(r.prefixTokens / this.blockSize); i++) {
      const block = this.blocks.find(b => b.key === this.key(r, i));
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
      b.used = 0;
      b.generation++;
      this.attach(r, [b.id], now);
    }
    r.blockTable.forEach((id, i) => {
      this.blocks[id].used = Math.min(this.blockSize, Math.max(0, tokens - i * this.blockSize));
    });
  }
  publish(r: Request) {
    for (let i = 0; i < Math.floor(r.prefixTokens / this.blockSize); i++) {
      const key = this.key(r, i);
      const b = this.blocks[r.blockTable[i]];
      // Concurrent cold prefills can compute duplicate pages; keep one canonical copy.
      if (b && b.used === this.blockSize && !this.blocks.some(x => x.key === key)) b.key = key;
    }
  }
  release(r: Request, keepPrefix: boolean, now: number) {
    for (const id of r.blockTable) {
      const b = this.blocks[id];
      b.owners = b.owners.filter(owner => owner !== r.id);
      b.lastUsed = now;
      if (!b.owners.length && (!keepPrefix || !b.key)) { b.key = null; b.used = 0; }
    }
  }
  clearUnused() {
    for (const b of this.blocks) if (!b.owners.length) { b.key = null; b.used = 0; }
  }
}
