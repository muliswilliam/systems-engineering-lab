import { sleep } from "./random.js";

/**
 * Exponential backoff + full jitter, reused fresh from Lab 37's own
 * `src/lib/retry.ts` (independent copy): `delay = random(0, min(maxDelayMs,
 * baseDelayMs * 2^(attempt-1)))`, and only for errors `isRetryable` says are
 * transient. See Lab 37's README for why retrying a non-transient rejection
 * is pure wasted load.
 */
export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable: (err: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  random?: () => number;
}

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const random = opts.random ?? Math.random;
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const attemptsRemain = attempt < opts.maxAttempts;
      if (!opts.isRetryable(err) || !attemptsRemain) {
        throw err;
      }
      const exponentialCap = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attempt - 1));
      const delayMs = random() * exponentialCap;
      opts.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * THE NAIVE SHAPE, kept here on purpose so the naive worker's bug is a real,
 * reachable code path rather than an implied one: fixed attempts, NO delay,
 * NO transient/non-transient distinction - every failure is retried
 * immediately. This is Lab 37's "retry storm" anti-pattern, composed here
 * against a REAL degraded downstream instead of a synthetic one.
 */
export async function retryImmediatelyNoBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  maxAttempts: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
