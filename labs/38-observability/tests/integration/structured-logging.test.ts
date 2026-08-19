import { afterAll, afterEach, beforeAll, it, expect } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { seedOrders } from "../../src/seed/seed.js";
import { startLabServer, resetLogFiles, type LabServerHandle } from "../../src/scenarios/harness.js";
import { generateTraffic, loadIdPools, summarizeTraffic } from "../../src/scenarios/traffic-generator.js";
import { parseStructuredLog, aggregateByRoute, attemptNaiveLogParse } from "../../src/observability/log-analysis.js";

const APP_PORT = Number(process.env.APP_PORT ?? 4438) + 2; // see metrics.test.ts for why not the bare APP_PORT
const STRUCTURED_LOG_FILE = "logs/test-structured-logging-structured.log";
const NAIVE_LOG_FILE = "logs/test-structured-logging-naive.log";

let handle: LabServerHandle;

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await seedOrders(pool, 200, 38);
  handle = await startLabServer(pool, APP_PORT, STRUCTURED_LOG_FILE, NAIVE_LOG_FILE);
});

afterAll(async () => {
  await handle.close();
  await pool.end();
});

// Each `it` below asserts an EXACT count against the traffic IT generated -
// without resetting between tests, a later test would silently also count
// every earlier test's accumulated lines in the same shared log file.
afterEach(async () => {
  await handle.flushLogs();
  resetLogFiles(handle.structuredLogFile, handle.naiveLogFile);
});

it("every structured log line for a completed request carries requestId, route, durationMs, and outcome", async () => {
  const ids = await loadIdPools(pool);
  await generateTraffic(handle.baseUrl, 150, 41, ids);
  await handle.flushLogs();

  const entries = parseStructuredLog(handle.structuredLogFile);
  const completions = entries.filter((e) => e.step === "request.complete");
  expect(completions.length).toBe(150);
  for (const entry of completions) {
    expect(typeof entry.requestId).toBe("string");
    expect(entry.requestId.length).toBeGreaterThan(0);
    expect(typeof entry.route).toBe("string");
    expect(typeof entry.durationMs).toBe("number");
    expect(["success", "not_found", "error"]).toContain(entry.outcome);
  }
});

it("aggregateByRoute computes an EXACT error rate and ordered percentiles (p50 <= p95 <= p99) from real log output", async () => {
  const ids = await loadIdPools(pool);
  const results = await generateTraffic(handle.baseUrl, 200, 42, ids);
  const mix = summarizeTraffic(results);
  await handle.flushLogs();

  const entries = parseStructuredLog(handle.structuredLogFile);
  const aggregates = aggregateByRoute(entries);
  const ordersAgg = aggregates.find((a) => a.route === "/orders/:id")!;

  // /orders/:id receives every bucket except "created" (POST /orders).
  const expectedOrdersTotal = mix.fast + mix.notFound + mix.slow + mix.error;
  expect(ordersAgg.total).toBe(expectedOrdersTotal);
  expect(ordersAgg.errorCount).toBe(mix.error);
  expect(ordersAgg.errorRate).toBeCloseTo(mix.error / expectedOrdersTotal, 4);

  expect(ordersAgg.latency.p50).toBeLessThanOrEqual(ordersAgg.latency.p95);
  expect(ordersAgg.latency.p95).toBeLessThanOrEqual(ordersAgg.latency.p99);

  // The "slow" bucket issues a real pg_sleep(0.3) - p99 must reflect it.
  expect(ordersAgg.latency.p99).toBeGreaterThanOrEqual(250);
});

it("the SAME requests, viewed only through naive.log's free-text lines, cannot be reliably aggregated", async () => {
  const ids = await loadIdPools(pool);
  await generateTraffic(handle.baseUrl, 100, 43, ids);
  await handle.flushLogs();

  const naiveResult = attemptNaiveLogParse(handle.naiveLogFile);
  expect(naiveResult.totalLines).toBe(100);
  // A single hand-written regex only matches ONE of the three real formats
  // this lab's naive logger writes for non-error outcomes - it must miss a
  // real, non-zero fraction of real lines.
  expect(naiveResult.failedToParse).toBeGreaterThan(0);
  expect(naiveResult.successfullyParsed).toBeLessThan(naiveResult.totalLines);
});
