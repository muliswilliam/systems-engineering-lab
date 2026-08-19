import { sleep } from "./random.js";

/**
 * Retries with EXPONENTIAL BACKOFF + FULL JITTER (AWS's "Exponential Backoff
 * And Jitter" algorithm: `delay = random(0, min(maxDelayMs, baseDelayMs * 2^(attempt-1)))`),
 * and ONLY for errors `isRetryable` says are transient. This is the precise
 * distinction CLAUDE.md's "Idempotency" section and this lab's README
 * "Scenario" require:
 *
 * - TRANSIENT (retryable here): the downstream was temporarily unavailable or
 *   the CALL timed out - the caller genuinely does not know whether the
 *   operation happened, and trying again (with backoff, so as not to pile on
 *   a struggling downstream) is a reasonable recovery strategy.
 * - NOT transient (never retried here, no matter how many attempts remain):
 *   a rejection that means "this exact request is invalid" (e.g. a
 *   validation error) - retrying it will deterministically fail again and
 *   only adds load for no benefit.
 *
 * This is the opposite failure mode of `naive-retry-storm`'s "retry
 * everything immediately with no backoff" - see this lab's README "Break it".
 */
export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable: (err: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Injectable RNG so tests and scenarios can assert exact jittered delays. */
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

  // Unreachable (the loop above always returns or throws), but keeps
  // TypeScript's control-flow analysis happy without a non-null assertion.
  throw lastError;
}
