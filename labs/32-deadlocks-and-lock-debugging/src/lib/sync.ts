/**
 * Explicit, in-process synchronization for a two-transaction race - per
 * CLAUDE.md's "Transactions and Concurrency" rule: "do not assert
 * correctness based purely on execution order or sleeps." Both transaction
 * legs run in the SAME Node process (against two independent `pg.Client`
 * connections), so a plain resolved/awaited `Promise` pair is a real
 * synchronization barrier, not a guess dressed up as one - each side
 * deterministically WAITS for the other's signal rather than hoping a fixed
 * delay was long enough.
 */
export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A one-shot, two-party rendezvous: each side calls `arrive()` once it has
 * reached the synchronization point (in this lab: right after taking its
 * FIRST row lock), then `await`s the OTHER side's `arrive()` before
 * proceeding to the step that creates the wait-for cycle (requesting the
 * SECOND row lock). Both sides therefore always attempt their second lock at
 * the same logical instant, every run - this is what makes the deadlock in
 * this lab reproducible on every execution rather than probabilistic.
 */
export function createTwoPartyBarrier(): { arriveAndWaitForPeer: () => Promise<void> } {
  const sideA = createDeferred();
  const sideB = createDeferred();
  let calls = 0;

  return {
    arriveAndWaitForPeer: async () => {
      calls += 1;
      if (calls === 1) {
        // First caller: this is "side A" for this barrier instance.
        sideA.resolve();
        await sideB.promise;
      } else {
        // Second caller: this is "side B".
        sideB.resolve();
        await sideA.promise;
      }
    },
  };
}
