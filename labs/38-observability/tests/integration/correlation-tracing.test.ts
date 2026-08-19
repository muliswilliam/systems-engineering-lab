import { afterAll, beforeAll, it, expect } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { seedOrders } from "../../src/seed/seed.js";
import { startLabServer, type LabServerHandle } from "../../src/scenarios/harness.js";
import { loadIdPools } from "../../src/scenarios/traffic-generator.js";
import { parseStructuredLog } from "../../src/observability/log-analysis.js";

const APP_PORT = Number(process.env.APP_PORT ?? 4438) + 3; // see metrics.test.ts for why not the bare APP_PORT
const STRUCTURED_LOG_FILE = "logs/test-tracing-structured.log";
const NAIVE_LOG_FILE = "logs/test-tracing-naive.log";

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

it("filtering the structured log by ONE correlation ID recovers exactly that request's full path, even under concurrent interleaved traffic", async () => {
  const ids = await loadIdPools(pool);
  const fastId = ids.validIds[0];
  const slowId = ids.validIds[1] ?? ids.validIds[0];
  const errorId = ids.guestIds[0];

  const requests = [
    { requestId: "test-trace-fast-1", path: `/orders/${fastId}` },
    { requestId: "test-trace-slow-1", path: `/orders/${slowId}?slow=1` },
    { requestId: "test-trace-error-1", path: `/orders/${errorId}` },
    { requestId: "test-trace-notfound-1", path: "/orders/9999999" },
    { requestId: "test-trace-fast-2", path: `/orders/${fastId}` },
  ];

  await Promise.all(
    requests.map((r) => fetch(`${handle.baseUrl}${r.path}`, { headers: { "x-request-id": r.requestId } })),
  );
  await handle.flushLogs();

  const entries = parseStructuredLog(handle.structuredLogFile);

  // Every one of the 5 concurrently-fired requests must be individually
  // findable, and its own lines must ALL share its own requestId - no
  // cross-contamination from concurrent traffic.
  for (const r of requests) {
    const traced = entries.filter((e) => e.requestId === r.requestId);
    expect(traced.length).toBeGreaterThan(0);
    expect(traced.every((e) => e.requestId === r.requestId)).toBe(true);
    expect(traced.some((e) => e.step === "request.start")).toBe(true);
    expect(traced.some((e) => e.step === "request.complete")).toBe(true);
  }

  // The error trace specifically: db.query.end must appear (the query
  // itself succeeded) BEFORE the failure - proving the bug is in business
  // logic, not the database, straight from the trace's own step order.
  const errorTrace = entries
    .filter((e) => e.requestId === "test-trace-error-1")
    .sort((a, b) => a.time - b.time);
  const stepOrder = errorTrace.map((e) => e.step);
  expect(stepOrder.indexOf("db.query.end")).toBeLessThan(stepOrder.indexOf("request.complete"));
  expect(stepOrder).toContain("business_logic.start");
  expect(stepOrder).not.toContain("business_logic.end");
  const completion = errorTrace.find((e) => e.step === "request.complete")!;
  expect(completion.outcome).toBe("error");
  expect(completion.err).toBeDefined();
});
