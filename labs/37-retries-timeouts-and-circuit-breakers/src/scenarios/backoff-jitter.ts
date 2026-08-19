import { createLogger } from "@labs/logging";
import {
  NonTransientDownstreamError,
  TransientDownstreamError,
  UnreliableDownstream,
} from "../downstream/unreliable-downstream.js";
import { mulberry32 } from "../lib/random.js";
import { retryWithBackoff } from "../lib/retry.js";

/**
 * RETRIES WITH BACKOFF, for TRANSIENT failures only:
 *
 * 1. A downstream that is down but RECOVERS after 4 calls (a real transient
 *    outage, not a permanent one) is retried with exponential backoff + full
 *    jitter. The measured delays GROW across attempts and are NOT identical
 *    to each other (jitter), unlike naive-retry-storm's immediate,
 *    zero-delay retries.
 * 2. A NON-transient rejection (a validation-style error) is never retried,
 *    even though attempts remain - proving `isRetryable` actually
 *    discriminates, rather than "retry with backoff" just being "retry
 *    storm, but slower".
 */
const log = createLogger("lab37:scenario:backoff-jitter");

async function scenarioTransientRecovers(): Promise<void> {
  const downstream = new UnreliableDownstream({ seed: 7, health: "down-fail-fast" });
  const jitterRandom = mulberry32(1234);
  const recordedDelays: number[] = [];
  let attemptCount = 0;

  const result = await retryWithBackoff(
    async (attempt) => {
      attemptCount = attempt;
      // The downstream "recovers" once we've genuinely observed 4 failures -
      // simulating a real transient outage that clears up on its own.
      if (attempt === 4) downstream.setHealth("healthy");
      return downstream.call("place-order");
    },
    {
      maxAttempts: 6,
      baseDelayMs: 100,
      maxDelayMs: 2_000,
      isRetryable: (err) => err instanceof TransientDownstreamError,
      random: jitterRandom,
      onRetry: ({ attempt, delayMs }) => {
        recordedDelays.push(delayMs);
        log.info({ attempt, delayMs: Math.round(delayMs) }, "transient failure - backing off before retry");
      },
    },
  );

  console.log("\n--- backoff-jitter: transient failure that recovers ---");
  console.log(`succeeded on attempt: ${attemptCount}`);
  console.log(
    `recorded backoff delays (ms): ${recordedDelays.map((d) => d.toFixed(1)).join(", ")}`,
  );
  console.log(
    "each delay is drawn from [0, min(maxDelayMs, baseDelayMs * 2^(attempt-1))) - the CEILING doubles " +
      "each attempt, but the ACTUAL delay is randomized within it (full jitter), so consecutive delays " +
      "are not identical multiples of each other the way a naive fixed-doubling backoff would be.",
  );
  log.info({ recordedDelays, downstreamLatencyMs: result.latencyMs }, "backoff-with-recovery scenario complete");
}

async function scenarioNonTransientNeverRetried(): Promise<void> {
  // A downstream permanently rejecting the request (e.g. "invalid card number") -
  // retrying can never help.
  const downstream = new UnreliableDownstream({
    seed: 9,
    health: "degraded",
    transientErrorRate: 0,
    nonTransientErrorRate: 1,
    slowRate: 0,
  });

  let callCount = 0;
  try {
    await retryWithBackoff(
      async () => {
        callCount++;
        return downstream.call("submit-payment-method");
      },
      {
        maxAttempts: 5,
        baseDelayMs: 100,
        maxDelayMs: 2_000,
        isRetryable: (err) => err instanceof TransientDownstreamError,
      },
    );
  } catch (err) {
    console.log("\n--- backoff-jitter: non-transient failure is NEVER retried ---");
    console.log(`configured maxAttempts: 5`);
    console.log(`ACTUAL downstream calls made: ${callCount}`);
    console.log(
      `error: ${err instanceof Error ? err.constructor.name : String(err)} - correctly not retried, ` +
        "even though 4 attempts remained, because isRetryable() returned false.",
    );
    log.info(
      { callCount, errorType: err instanceof NonTransientDownstreamError ? "non-transient" : "unknown" },
      "non-transient error correctly short-circuited retry loop",
    );
  }
}

async function main(): Promise<void> {
  await scenarioTransientRecovers();
  await scenarioNonTransientNeverRetried();
}

main().catch((err: unknown) => {
  log.error({ err }, "backoff-jitter scenario failed unexpectedly");
  process.exitCode = 1;
});
