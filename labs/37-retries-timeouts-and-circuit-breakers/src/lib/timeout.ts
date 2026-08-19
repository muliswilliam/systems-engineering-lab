/**
 * Bounds how long a caller will WAIT for `fn` to settle. This is a client-side
 * guarantee only: `Promise.race` does not stop `fn` from continuing to run in
 * the background (see README "Production notes" - a real HTTP client needs an
 * `AbortController` wired all the way into the downstream call for the work
 * itself to stop; this lab's simulated downstream deliberately keeps "running"
 * after a timeout to make that exact gap observable in the idempotency
 * scenario, where the downstream's side effect already committed before the
 * client gave up).
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
