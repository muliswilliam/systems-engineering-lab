import { describe, expect, it } from "vitest";
import { retryWithBackoff } from "../../src/lib/retry.js";

class TransientError extends Error {}
class PermanentError extends Error {}

function fixedRandomSequence(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

describe("retryWithBackoff", () => {
  it("returns the result immediately when the first attempt succeeds (no retries)", async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        return "ok";
      },
      { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100, isRetryable: () => true, random: () => 0 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries a retryable error until it succeeds within maxAttempts", async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 3) throw new TransientError("not yet");
        return "ok";
      },
      {
        maxAttempts: 5,
        baseDelayMs: 1,
        maxDelayMs: 10,
        isRetryable: (err) => err instanceof TransientError,
        random: () => 0,
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws after exhausting maxAttempts on a persistently retryable error", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls++;
          throw new TransientError("always fails");
        },
        { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 10, isRetryable: () => true, random: () => 0 },
      ),
    ).rejects.toBeInstanceOf(TransientError);
    expect(calls).toBe(4);
  });

  it("never retries a non-retryable error, even with attempts remaining", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls++;
          throw new PermanentError("never retry me");
        },
        {
          maxAttempts: 10,
          baseDelayMs: 1,
          maxDelayMs: 10,
          isRetryable: (err) => err instanceof TransientError, // PermanentError is not retryable
        },
      ),
    ).rejects.toBeInstanceOf(PermanentError);
    expect(calls).toBe(1);
  });

  it("computes exact full-jitter delays from an injected deterministic RNG", async () => {
    const recordedDelays: number[] = [];
    const random = fixedRandomSequence([0.5, 0.25, 1]);
    let calls = 0;

    await expect(
      retryWithBackoff(
        async () => {
          calls++;
          throw new TransientError("fails every time");
        },
        {
          maxAttempts: 4,
          baseDelayMs: 100,
          maxDelayMs: 10_000,
          isRetryable: () => true,
          random,
          onRetry: ({ delayMs }) => recordedDelays.push(delayMs),
        },
      ),
    ).rejects.toBeInstanceOf(TransientError);

    // delay = random() * min(maxDelayMs, baseDelayMs * 2^(attempt-1))
    // attempt 1 fails -> cap = 100   -> delay = 0.5  * 100 = 50
    // attempt 2 fails -> cap = 200   -> delay = 0.25 * 200 = 50
    // attempt 3 fails -> cap = 400   -> delay = 1    * 400 = 400
    expect(recordedDelays).toEqual([50, 50, 400]);
    // Growing CEILING (100 -> 200 -> 400) but NOT identical or deterministically
    // doubling delays, because jitter draws a different fraction of each cap.
    expect(calls).toBe(4);
  });

  it("clamps the exponential ceiling at maxDelayMs so backoff does not grow unbounded", async () => {
    const recordedCeilings: number[] = [];
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls++;
          throw new TransientError("fails every time");
        },
        {
          maxAttempts: 8,
          baseDelayMs: 100,
          maxDelayMs: 500,
          isRetryable: () => true,
          random: () => 1, // delay == the ceiling exactly, so we can read it directly
          onRetry: ({ delayMs }) => recordedCeilings.push(delayMs),
        },
      ),
    ).rejects.toBeInstanceOf(TransientError);

    // Uncapped ceilings would be 100,200,400,800,1600,... - capped at 500.
    expect(recordedCeilings).toEqual([100, 200, 400, 500, 500, 500, 500]);
    expect(calls).toBe(8);
  });
});
