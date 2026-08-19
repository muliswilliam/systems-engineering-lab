import { afterAll, beforeAll, it, expect } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { seedOrders } from "../../src/seed/seed.js";
import { startLabServer, type LabServerHandle } from "../../src/scenarios/harness.js";
import { generateTraffic, loadIdPools, summarizeTraffic } from "../../src/scenarios/traffic-generator.js";

// Deliberately NOT the bare APP_PORT (4438) - that is `pnpm dev`'s port, the
// one docker-compose.yml's Prometheus container actually scrapes every 5s.
// If Prometheus happened to be running and scraping during this test, its
// own scrape would land in the SAME metrics this test asserts an exact
// count against, making the assertion flaky depending on Docker state. Every
// test/scenario in this lab that starts its own ephemeral server uses an
// offset port for exactly this reason.
const APP_PORT = Number(process.env.APP_PORT ?? 4438) + 1;
const STRUCTURED_LOG_FILE = "logs/test-metrics-structured.log";
const NAIVE_LOG_FILE = "logs/test-metrics-naive.log";

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

/** Sums every `metricName{...} value` line's numeric value out of a real
 * scraped Prometheus text body - a small, deliberately dumb parser (this is
 * a TEST asserting on the real wire format, not re-implementing prom-client). */
function sumMetricLines(body: string, metricName: string): number {
  return body
    .split("\n")
    .filter((line) => line.startsWith(`${metricName}{`) || line.startsWith(`${metricName} `))
    .reduce((sum, line) => sum + Number(line.split(" ").pop()), 0);
}

it("http_requests_total, scraped from a real GET /metrics, exactly matches the number of requests actually made", async () => {
  const ids = await loadIdPools(pool);
  const results = await generateTraffic(handle.baseUrl, 120, 38, ids);
  const mix = summarizeTraffic(results);
  const expectedTotal = mix.fast + mix.notFound + mix.slow + mix.error + mix.create;
  expect(expectedTotal).toBe(120);

  const response = await fetch(`${handle.baseUrl}/metrics`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/plain");
  const body = await response.text();

  const totalFromMetrics = sumMetricLines(body, "http_requests_total");
  expect(totalFromMetrics).toBe(120);

  // Every 5xx response increments http_errors_total for its route - the
  // guest-checkout bug lands exclusively on /orders/:id.
  const errorsFromMetrics = sumMetricLines(body, "http_errors_total");
  expect(errorsFromMetrics).toBe(mix.error);

  // http_request_duration_seconds is a real Histogram: its `_count` sum
  // must equal the exact same total, per bucket accounting.
  const histogramCount = sumMetricLines(body, "http_request_duration_seconds_count");
  expect(histogramCount).toBe(120);
});

it("http_requests_in_flight settles back to exactly 1 (only the /metrics scrape itself) once all prior traffic has completed", async () => {
  const ids = await loadIdPools(pool);
  // `generateTraffic` awaits each request in turn, so by the time it
  // resolves nothing from THIS batch is still in flight.
  await generateTraffic(handle.baseUrl, 20, 39, ids);

  const body = await (await fetch(`${handle.baseUrl}/metrics`)).text();
  const inFlightLine = body.split("\n").find((line) => line.startsWith("http_requests_in_flight "));
  expect(inFlightLine).toBeDefined();
  // A genuinely real, easy-to-miss self-referential nuance: the gauge is
  // sampled and rendered WHILE the /metrics request that reads it is
  // itself still "in flight" (`httpRequestsInFlight.inc()` runs before the
  // response body is built, `.dec()` only runs in the `finally` block after
  // it is sent) - so a perfectly healthy, fully-drained service reports `1`
  // here, not `0`. Real production dashboards for this metric account for
  // exactly this off-by-one-self.
  expect(Number(inFlightLine!.split(" ").pop())).toBe(1);
});

it("db_pool_total_clients is sampled from the real pg.Pool and is never negative or absent", async () => {
  const ids = await loadIdPools(pool);
  await generateTraffic(handle.baseUrl, 5, 40, ids);
  const body = await (await fetch(`${handle.baseUrl}/metrics`)).text();
  const totalLine = body.split("\n").find((line) => line.startsWith("db_pool_total_clients "));
  expect(totalLine).toBeDefined();
  expect(Number(totalLine!.split(" ").pop())).toBeGreaterThanOrEqual(0);
});
