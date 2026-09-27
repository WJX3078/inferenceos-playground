// Deterministic RNG shared by the engine, workload generator and experiments.
// A tiny 32-bit LCG (numerical-recipes constants) is enough for simulation use
// and keeps the stream identical across browser and Node runs.

export type Rng = () => number;

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** 32-bit FNV-1a over a list of integers — used for synthetic token ids and block hashes. */
export function fnv1a(...values: number[]): number {
  let hash = 0x811c9dc5;
  for (const v of values) {
    hash ^= v & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (v >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (v >>> 16) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (v >>> 24) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export const hashHex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');

/** Exponential inter-arrival in ms for a Poisson process with the given rate (req/s). */
export const poissonDelayMs = (rng: Rng, rate: number) =>
  Math.max(1, Math.round(-Math.log(1 - Math.min(0.999999, rng())) / Math.max(1e-6, rate) * 1000));

/** Sample a weighted discrete option. weights need not sum to 1. */
export function weightedPick<T extends string>(rng: Rng, entries: { value: T; weight: number }[]): T {
  const total = entries.reduce((n, e) => n + Math.max(0, e.weight), 0);
  if (total <= 0) return entries[0].value;
  let roll = rng() * total;
  for (const e of entries) {
    roll -= Math.max(0, e.weight);
    if (roll <= 0) return e.value;
  }
  return entries.at(-1)!.value;
}
