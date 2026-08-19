import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
import { BoundedResource, callSlowDownstream } from "../downstream/slow-downstream.js";

const log = createLogger("lab36:scenario:naive-overload");

// A real, finite downstream capacity - e.g. a fixed outbound connection pool
// to a payment gateway. 10 concurrent calls can be in flight at once; the
// 11th caller queues behind them.
const DOWNSTREAM_CAPACITY = 10;
const DOWNSTREAM_LATENCY_MS = 250;
const ACQUIRE_TIMEOUT_MS = 1_000;
const CONCURRENT_REQUESTS = 200;

/**
 * The unprotected baseline this lab's naive scenario reproduces: an API
 * handler with NO limit on how many requests it will forward to a slow
 * downstream dependency at once, and NO rate limit on incoming requests
 * either. This is the application-layer overload case CLAUDE.md's Lab 23
 * does NOT cover (that lab is about Postgres connection pooling
 * specifically) - here the "pool" being exhausted is a generic in-process
 * bounded resource standing in for any slow, capacity-limited dependency.
 */
async function main(): Promise<void> {
  const resource = new BoundedResource(DOWNSTREAM_CAPACITY);

  log.info(
    {
      downstreamCapacity: DOWNSTREAM_CAPACITY,
      downstreamLatencyMs: DOWNSTREAM_LATENCY_MS,
      acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
      concurrentRequests: CONCURRENT_REQUESTS,
    },
    "starting naive overload burst (no rate limit, no backpressure)",
  );

  const start = Date.now();
  const results = await runConcurrently(CONCURRENT_REQUESTS, () =>
    callSlowDownstream(resource, DOWNSTREAM_LATENCY_MS, ACQUIRE_TIMEOUT_MS),
  );
  const elapsedMs = Date.now() - start;

  const succeeded = countFulfilled(results);
  const failed = results.length - succeeded;
  const theoreticalMaxServed = DOWNSTREAM_CAPACITY * Math.floor(ACQUIRE_TIMEOUT_MS / DOWNSTREAM_LATENCY_MS);

  log.warn(
    {
      concurrentRequests: CONCURRENT_REQUESTS,
      succeeded,
      failed,
      theoreticalMaxServedWithinTimeout: theoreticalMaxServed,
      elapsedMs,
    },
    failed > 0
      ? "OVERLOAD CONFIRMED: real acquire-timeout errors occurred because more requests arrived than the downstream could ever serve within its own timeout budget"
      : "unexpected: no requests failed this run - try raising CONCURRENT_REQUESTS or lowering ACQUIRE_TIMEOUT_MS",
  );

  if (failed > 0) {
    const sampleError = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    log.warn({ sampleError: String(sampleError?.reason) }, "example of a real captured failure");
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "naive overload scenario failed");
    process.exit(1);
  });
}
