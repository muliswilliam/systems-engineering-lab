import { createLogger } from "@labs/logging";
import { UnreliableDownstream } from "../downstream/unreliable-downstream.js";

/**
 * NAIVE: no timeout at all. A hanging downstream call ties up the caller for
 * however long the downstream takes to eventually respond - here `hangMs`
 * (5000ms), standing in for a real-world default that is often either far
 * longer (many HTTP client libraries default to no timeout, or to OS-level
 * TCP defaults measured in MINUTES) or literally unbounded.
 */
const log = createLogger("lab37:scenario:naive-hang");

async function main(): Promise<void> {
  const downstream = new UnreliableDownstream({ seed: 37, health: "down-hang", hangMs: 5_000 });

  log.info("calling a downstream that is overloaded and slow to respond, with NO timeout");
  const startedAt = Date.now();

  // This is the entire naive client: just await the call. Nothing bounds it.
  const result = await downstream.call("get-order-status");

  const elapsedMs = Date.now() - startedAt;
  log.info(
    { elapsedMs, downstreamLatencyMs: result.latencyMs },
    "call finally returned - the caller was blocked for the FULL downstream delay, with zero ability to give up earlier",
  );

  console.log("\n--- naive-hang: real captured numbers ---");
  console.log(`caller was blocked for: ${elapsedMs}ms`);
  console.log(
    "in production, a hang like this is bounded only by whatever default your HTTP client/library " +
      "happens to ship with - often 0 (no timeout) or a value measured in MINUTES, not something this " +
      "application chose deliberately. See scenario:timeout for the fix.",
  );
}

main().catch((err: unknown) => {
  log.error({ err }, "naive-hang scenario failed unexpectedly");
  process.exitCode = 1;
});
