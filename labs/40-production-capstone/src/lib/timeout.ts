/**
 * Bounds how long a caller will wait for `fn` to settle. Reused fresh from
 * Lab 37's own `src/lib/timeout.ts` (independent copy) - see that lab's
 * README for the full explanation of why this is a CLIENT-side guarantee
 * only (`Promise.race` does not stop `fn` from continuing to run in the
 * background). That gap is exactly why this capstone's naive worker (no
 * timeout, no breaker) can pile up in-flight calls against a hung
 * downstream while believing nothing has "failed" yet.
 */
export class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`operation timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
    fn().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
