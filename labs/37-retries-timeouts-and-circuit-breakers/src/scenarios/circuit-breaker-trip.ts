import { createLogger } from "@labs/logging";
import { CircuitBreaker, CircuitOpenError } from "../lib/circuit-breaker.js";
import { UnreliableDownstream } from "../downstream/unreliable-downstream.js";
import { sleep } from "../lib/random.js";

/**
 * CIRCUIT BREAKER: CLOSED -> OPEN -> HALF_OPEN -> CLOSED (and, in a second
 * run, -> OPEN again). A downstream that is genuinely down should stop being
 * called at all once that is clear - not retried, not timed out repeatedly,
 * just fast-failed - until a cooldown has passed and a single probe call
 * proves the downstream is healthy again.
 */
const log = createLogger("lab37:scenario:circuit-breaker");

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 300;

async function main(): Promise<void> {
  const downstream = new UnreliableDownstream({ seed: 11, health: "down-fail-fast" });
  const breaker = new CircuitBreaker({
    failureThreshold: FAILURE_THRESHOLD,
    cooldownMs: COOLDOWN_MS,
    onStateChange: (from, to, info) => log.info({ from, to, ...info }, "circuit breaker state transition"),
  });

  console.log("\n--- circuit-breaker: tripping to OPEN ---");
  const latenciesMs: Array<{ call: number; latencyMs: number; outcome: string }> = [];

  for (let i = 1; i <= 8; i++) {
    const startedAt = Date.now();
    try {
      await breaker.execute(() => downstream.call(`inventory-check-${i}`));
      latenciesMs.push({ call: i, latencyMs: Date.now() - startedAt, outcome: "success" });
    } catch (err) {
      const outcome = err instanceof CircuitOpenError ? "fast-failed (breaker OPEN)" : "downstream error";
      latenciesMs.push({ call: i, latencyMs: Date.now() - startedAt, outcome });
    }
  }

  for (const entry of latenciesMs) {
    console.log(`  call ${entry.call}: ${entry.latencyMs}ms - ${entry.outcome}`);
  }
  console.log(`breaker state after 8 calls: ${breaker.getState()}`);
  console.log(`downstream.totalCallCount:   ${downstream.totalCallCount} (threshold was ${FAILURE_THRESHOLD})`);
  console.log(
    `real, measured contrast: the ${FAILURE_THRESHOLD} calls that actually reached the downstream took ` +
      `${latenciesMs
        .slice(0, FAILURE_THRESHOLD)
        .map((e) => e.latencyMs)
        .join("/")}ms each, while every call AFTER the breaker opened was rejected in ` +
      `${latenciesMs
        .slice(FAILURE_THRESHOLD)
        .map((e) => e.latencyMs)
        .join("/")}ms - a near-zero-latency fast-fail, not even a timeout-bound wait.`,
  );

  log.info(
    { breakerState: breaker.getState(), downstreamCalls: downstream.totalCallCount },
    "breaker tripped to OPEN, further calls fast-failed without touching the downstream",
  );

  console.log("\n--- circuit-breaker: HALF_OPEN probe succeeds, closes ---");
  downstream.setHealth("healthy"); // the downstream has recovered
  await sleep(COOLDOWN_MS + 20); // let the cooldown genuinely elapse

  const callsBeforeProbe = downstream.totalCallCount;
  await breaker.execute(() => downstream.call("probe-after-cooldown"));
  console.log(`breaker state after successful probe: ${breaker.getState()}`);
  console.log(`downstream calls made by the probe: ${downstream.totalCallCount - callsBeforeProbe} (exactly 1 expected)`);

  console.log("\n--- circuit-breaker: HALF_OPEN probe fails, reopens ---");
  downstream.setHealth("down-fail-fast"); // still down after all
  for (let i = 0; i < FAILURE_THRESHOLD; i++) {
    try {
      await breaker.execute(() => downstream.call(`re-failing-${i}`));
    } catch {
      // expected
    }
  }
  console.log(`breaker state after re-failing: ${breaker.getState()}`);
  await sleep(COOLDOWN_MS + 20);
  try {
    await breaker.execute(() => downstream.call("probe-still-down"));
  } catch {
    // expected: probe fails, breaker reopens
  }
  console.log(`breaker state after a FAILED probe: ${breaker.getState()} (expected OPEN again)`);

  log.info({ finalState: breaker.getState() }, "half-open probe-fails-then-reopens scenario complete");
}

main().catch((err: unknown) => {
  log.error({ err }, "circuit-breaker scenario failed unexpectedly");
  process.exitCode = 1;
});
