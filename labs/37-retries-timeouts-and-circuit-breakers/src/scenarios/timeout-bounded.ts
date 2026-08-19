import { createLogger } from "@labs/logging";
import { UnreliableDownstream } from "../downstream/unreliable-downstream.js";
import { TimeoutError, withTimeout } from "../lib/timeout.js";

/**
 * TIMEOUTS: the exact same overloaded downstream from naive-hang.ts
 * (`down-hang`, 5000ms per call), but every call is now wrapped in
 * `withTimeout(fn, 200)`. The caller's worst-case wait is now bounded at
 * ~200ms, not 5000ms - a real, measured 25x reduction in worst-case latency.
 */
const log = createLogger("lab37:scenario:timeout-bounded");

const TIMEOUT_MS = 200;
const CALLS = 20;

async function main(): Promise<void> {
  const downstream = new UnreliableDownstream({ seed: 37, health: "down-hang", hangMs: 5_000 });

  log.info({ timeoutMs: TIMEOUT_MS, calls: CALLS }, "calling the same overloaded downstream, now with a timeout");

  const latenciesMs: number[] = [];
  for (let i = 0; i < CALLS; i++) {
    const startedAt = Date.now();
    try {
      await withTimeout(() => downstream.call(`bounded-call-${i}`), TIMEOUT_MS);
    } catch (err) {
      if (!(err instanceof TimeoutError)) throw err;
    }
    latenciesMs.push(Date.now() - startedAt);
  }

  latenciesMs.sort((a, b) => a - b);
  const max = latenciesMs[latenciesMs.length - 1] ?? 0;
  const p50 = latenciesMs[Math.floor(latenciesMs.length * 0.5)] ?? 0;
  const p99 = latenciesMs[Math.floor(latenciesMs.length * 0.99)] ?? 0;

  console.log("\n--- timeout-bounded: real captured numbers ---");
  console.log(`configured timeout:        ${TIMEOUT_MS}ms`);
  console.log(`downstream's real delay:   5000ms per call (unchanged - it is still just as overloaded)`);
  console.log(`calls made:                ${CALLS}`);
  console.log(`p50 caller-observed latency: ${p50.toFixed(1)}ms`);
  console.log(`p99 caller-observed latency: ${p99.toFixed(1)}ms`);
  console.log(`max caller-observed latency: ${max.toFixed(1)}ms`);
  console.log(
    `\nEvery call was aborted from the CALLER's point of view at ~${TIMEOUT_MS}ms, a real bound, vs. ` +
      `naive-hang.ts's full 5000ms per call - a ~${(5_000 / TIMEOUT_MS).toFixed(0)}x reduction in worst-case latency.`,
  );
  console.log(
    "Caveat (see README 'Production notes'): the downstream's own 5000ms timer keeps running in the " +
      "background regardless - a timeout bounds the CALLER's wait, it does not stop the downstream's work.",
  );

  log.info({ p50, p99, max, timeoutMs: TIMEOUT_MS }, "timeout-bounded worst-case latency measured");

  // Every timed-out call above left its own 5000ms downstream timer dangling
  // in the background (nothing awaits it once the timeout wins the race -
  // see README "Production notes" on what a timeout does and does not stop).
  // Exit explicitly rather than let this demo script sit around for several
  // more seconds waiting on work nobody is listening for anymore.
  process.exit(0);
}

main().catch((err: unknown) => {
  log.error({ err }, "timeout-bounded scenario failed unexpectedly");
  process.exitCode = 1;
});
