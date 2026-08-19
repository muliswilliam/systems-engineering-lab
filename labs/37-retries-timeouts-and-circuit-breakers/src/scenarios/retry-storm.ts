import { createLogger } from "@labs/logging";
import { runConcurrently } from "@labs/test-utils";
import { UnreliableDownstream } from "../downstream/unreliable-downstream.js";

/**
 * NAIVE RETRY STORM: the downstream is genuinely down (every call fails
 * immediately). 50 concurrent callers each naively retry up to 5 times with
 * NO backoff and NO circuit breaker - the exact anti-pattern this lab's
 * README warns about: retrying during an outage with no restraint makes the
 * outage WORSE by amplifying request volume against a downstream that is
 * already failing.
 */
const log = createLogger("lab37:scenario:retry-storm");

const CALLERS = 50;
const ATTEMPTS_PER_CALLER = 5;

async function naiveRetry(downstream: UnreliableDownstream, callerId: number): Promise<void> {
  for (let attempt = 1; attempt <= ATTEMPTS_PER_CALLER; attempt++) {
    try {
      await downstream.call(`caller-${callerId}`);
      return; // would only happen if the downstream were actually healthy
    } catch {
      // naive: immediately try again, no backoff, no check on whether this is
      // even worth retrying - exactly what NOT to do (contrast with
      // scenario:backoff).
    }
  }
}

async function main(): Promise<void> {
  const downstream = new UnreliableDownstream({ seed: 37, health: "down-fail-fast" });

  log.info(
    { callers: CALLERS, attemptsPerCaller: ATTEMPTS_PER_CALLER },
    "downstream is DOWN (every call fails immediately) - simulating naive concurrent retries with no backoff",
  );

  const startedAt = Date.now();
  await runConcurrently(CALLERS, (callerId) => naiveRetry(downstream, callerId));
  const elapsedMs = Date.now() - startedAt;

  const expectedCalls = CALLERS * ATTEMPTS_PER_CALLER;
  const actualCalls = downstream.totalCallCount;

  console.log("\n--- retry-storm: real captured numbers ---");
  console.log(`concurrent callers:        ${CALLERS}`);
  console.log(`naive retries per caller:  ${ATTEMPTS_PER_CALLER}`);
  console.log(`expected downstream calls: ${expectedCalls}`);
  console.log(`ACTUAL downstream calls:   ${actualCalls}`);
  console.log(`amplification factor:      ${(actualCalls / CALLERS).toFixed(1)}x per logical request`);
  console.log(`wall clock:                ${elapsedMs}ms`);
  console.log(
    "\nEvery one of those calls failed anyway - the downstream was down the entire time - so this " +
      "amplification bought ZERO successful requests while multiplying load on an already-struggling " +
      "system by 5x. See scenario:circuit-breaker for how to stop this.",
  );

  log.info({ expectedCalls, actualCalls, elapsedMs }, "retry storm amplification measured");
}

main().catch((err: unknown) => {
  log.error({ err }, "retry-storm scenario failed unexpectedly");
  process.exitCode = 1;
});
