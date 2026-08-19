/**
 * Deterministic PRNG (mulberry32) + a plain sleep helper, reused fresh from
 * Lab 37's own `src/lib/random.ts` (independent copy, per the
 * independent-labs principle) so the simulated notification downstream's
 * "unreliable but reproducible" behavior can be seeded exactly like Lab 37's
 * `UnreliableDownstream`.
 */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
