/**
 * A tiny seeded PRNG (mulberry32) so every scenario and test in this lab is
 * deterministic-but-realistic: the SAME seed always produces the SAME
 * sequence of "failures", "slow responses", and jitter values, per SPEC.md
 * section 8.1's determinism requirement - applied here to failure injection
 * rather than seed data, since this lab has no database to seed.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A plain, ref'd `setTimeout`-backed sleep. Deliberately NOT unref'd: several
 * scenarios in this lab (e.g. `naive-hang.ts`) exist specifically to prove
 * that an awaited call genuinely blocks the caller for its full duration -
 * an unref'd timer would let the Node process exit before that promise ever
 * settles, silently defeating the demonstration. Scenario scripts that
 * deliberately ABANDON a losing race (see `withTimeout`'s caller in
 * `timeout-bounded.ts`) call `process.exit()` once their own measurement is
 * done instead, rather than pushing this concern into the sleep primitive.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
