import { createLogger } from "@labs/logging";
import { CircuitBreaker, CircuitOpenError } from "../lib/circuit-breaker.js";
import { UnreliableDownstream, TransientDownstreamError } from "../downstream/unreliable-downstream.js";
import { retryWithBackoff } from "../lib/retry.js";
import { TimeoutError, withTimeout } from "../lib/timeout.js";
import { sleep } from "../lib/random.js";

/**
 * TIE IT TOGETHER: timeout + backoff-retry + circuit breaker, all wrapping
 * the SAME unreliable downstream, LAYERED IN THE ORDER THIS LAB'S README
 * ARGUES FOR:
 *
 *   breaker.execute(() =>
 *     retryWithBackoff((attempt) =>
 *       withTimeout(() => downstream.call(...), timeoutMs)
 *     , retryOpts)
 *   )
 *
 * - The circuit breaker is OUTERMOST: while OPEN, it rejects before a
 *   timeout-bound call is even attempted - no wasted wait, no wasted retry.
 * - The retry loop is INSIDE the breaker's `execute`: the breaker sees ONE
 *   logical outcome per `execute()` call (the whole retry sequence succeeded
 *   or it didn't), not one outcome per individual downstream attempt. This
 *   matters: if retries wrapped the breaker instead, each individual retry
 *   attempt would separately consult (and could separately trip or re-trip)
 *   the breaker, and a retry loop sitting outside an OPEN breaker would just
 *   keep re-entering it - still a smaller, but real, storm.
 * - The timeout is INSIDE each retry attempt, not around the whole retry
 *   sequence once: each individual attempt needs its own bounded worst case,
 *   otherwise one global timeout could cut off a LATER attempt that would
 *   have succeeded quickly.
 */
const log = createLogger("lab37:scenario:composed");

const TIMEOUT_MS = 150;
const RETRY_OPTS = { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 500 };
const FAILURE_THRESHOLD = 4;
const COOLDOWN_MS = 300;

function makeCall(downstream: UnreliableDownstream, breaker: CircuitBreaker, label: string) {
  return breaker.execute(() =>
    retryWithBackoff(
      () => withTimeout(() => downstream.call(label), TIMEOUT_MS),
      {
        ...RETRY_OPTS,
        isRetryable: (err) => err instanceof TransientDownstreamError || err instanceof TimeoutError,
        onRetry: ({ attempt, delayMs }) =>
          log.info({ label, attempt, delayMs: Math.round(delayMs) }, "composed: retrying inside breaker's attempt"),
      },
    ),
  );
}

async function main(): Promise<void> {
  const downstream = new UnreliableDownstream({ seed: 99, health: "down-fail-fast" });
  const breaker = new CircuitBreaker({
    failureThreshold: FAILURE_THRESHOLD,
    cooldownMs: COOLDOWN_MS,
    onStateChange: (from, to, info) => log.info({ from, to, ...info }, "composed: breaker state transition"),
  });

  console.log("\n--- composed: sustained outage, breaker trips after full retry sequences fail ---");
  let executeCallCount = 0;
  for (let i = 1; i <= FAILURE_THRESHOLD + 2; i++) {
    executeCallCount++;
    const callsBefore = downstream.totalCallCount;
    try {
      await makeCall(downstream, breaker, `order-${i}`);
    } catch {
      // expected during the outage
    }
    const downstreamCallsThisExecute = downstream.totalCallCount - callsBefore;
    console.log(
      `  execute() #${i}: breaker=${breaker.getState()}, downstream calls this attempt sequence: ${downstreamCallsThisExecute}`,
    );
  }

  console.log(
    `\nbreaker opened after ${FAILURE_THRESHOLD} FAILED execute() calls (each one containing up to ` +
      `${RETRY_OPTS.maxAttempts} internal retries) - not after ${FAILURE_THRESHOLD} individual downstream ` +
      `attempts. Total downstream calls actually made: ${downstream.totalCallCount}, vs. the ` +
      `${executeCallCount * RETRY_OPTS.maxAttempts} it would have been with NO breaker at all.`,
  );

  console.log("\n--- composed: recovery via HALF_OPEN probe ---");
  downstream.setHealth("healthy");
  await sleep(COOLDOWN_MS + 20);
  const callsBeforeRecovery = downstream.totalCallCount;
  await makeCall(downstream, breaker, "order-recovered");
  console.log(`breaker state after recovery: ${breaker.getState()}`);
  console.log(`downstream calls made by the recovery probe sequence: ${downstream.totalCallCount - callsBeforeRecovery}`);

  log.info(
    { finalState: breaker.getState(), totalDownstreamCalls: downstream.totalCallCount },
    "composed timeout+backoff+circuit-breaker scenario complete",
  );
}

main().catch((err: unknown) => {
  log.error({ err }, "composed scenario failed unexpectedly");
  process.exitCode = 1;
});
