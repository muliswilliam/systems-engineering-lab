import { createLogger } from "@labs/logging";

/**
 * This lab has no database to reconcile against (see README "Architecture"),
 * so `pnpm dev` is a short guided tour instead of a reconciliation report:
 * it prints what each scenario demonstrates and how to run it individually.
 * Every scenario is independently runnable and prints its own real captured
 * numbers - this is just an index into them.
 */
const log = createLogger("lab37:dev");

const SCENARIOS: Array<{ command: string; summary: string }> = [
  {
    command: "pnpm scenario:naive-hang",
    summary: "NO timeout: a single overloaded downstream call blocks the caller for its full delay.",
  },
  {
    command: "pnpm scenario:retry-storm",
    summary: "NO backoff: 50 concurrent callers x 5 naive retries against a down downstream = a real 250-call storm.",
  },
  {
    command: "pnpm scenario:timeout",
    summary: "Add a timeout: the SAME overloaded downstream, now with a real bounded worst-case latency.",
  },
  {
    command: "pnpm scenario:backoff",
    summary: "Retries with exponential backoff + jitter, for transient failures ONLY - never for non-transient ones.",
  },
  {
    command: "pnpm scenario:idempotency",
    summary:
      "A caller's own timeout races a slow-but-successful downstream charge - naive retry double-charges; " +
      "an idempotency key (Lab 15's pattern, in-memory here) fixes it.",
  },
  {
    command: "pnpm scenario:circuit-breaker",
    summary: "CLOSED -> OPEN -> HALF_OPEN -> CLOSED/OPEN, with fast-fail latency measured against timeout-bound latency.",
  },
  {
    command: "pnpm scenario:composed",
    summary: "All three mechanisms layered correctly: breaker outermost, retries inside it, timeout inside each retry.",
  },
];

function main(): void {
  console.log("Lab 37 - Retries, Timeouts, and Circuit Breakers\n");
  console.log("Run each scenario independently to see its own real captured numbers:\n");
  for (const { command, summary } of SCENARIOS) {
    console.log(`  ${command}`);
    console.log(`    ${summary}\n`);
  }
  log.info({ scenarioCount: SCENARIOS.length }, "lab overview printed - run pnpm test for the automated invariant checks");
}

main();
