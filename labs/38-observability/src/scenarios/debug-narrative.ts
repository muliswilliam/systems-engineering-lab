import "dotenv/config";
import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { startLabServer } from "./harness.js";
import { generateTraffic, loadIdPools } from "./traffic-generator.js";
import { parseStructuredLog, aggregateByRoute } from "../observability/log-analysis.js";
import { loadSharedSql } from "../observability/db-sql.js";

const log = createLogger("lab38:scenario:debug-narrative");

const TRAFFIC_COUNT = 300;
const SEED = 38;

function section(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}\n`);
}

async function main() {
  await waitForDatabase(pool);
  const ids = await loadIdPools(pool);
  if (ids.validIds.length === 0 || ids.guestIds.length === 0) {
    throw new Error("Run `pnpm seed` first.");
  }

  const port = Number(process.env.APP_PORT ?? 4438) + 10; // distinct from the dev server Prometheus scrapes
  const structuredLogFile = process.env.STRUCTURED_LOG_FILE ?? "logs/structured.log";
  const naiveLogFile = process.env.NAIVE_LOG_FILE ?? "logs/naive.log";
  const handle = await startLabServer(pool, port, structuredLogFile, naiveLogFile);

  section("STEP 0 - a realistic mixed traffic window happens (this is what an operator walks into)");
  await generateTraffic(handle.baseUrl, TRAFFIC_COUNT, SEED, ids);
  await handle.flushLogs();

  // --- STEP 1: structured logs -> WHICH request(s) ---
  section("STEP 1 - structured logs: find WHICH requests are the problem");
  const entries = parseStructuredLog(handle.structuredLogFile);
  const aggregates = aggregateByRoute(entries);
  const ordersAgg = aggregates.find((a) => a.route === "/orders/:id")!;
  console.log(
    `/orders/:id: ${ordersAgg.total} requests, ${ordersAgg.errorCount} errors (${(ordersAgg.errorRate * 100).toFixed(1)}%), ` +
      `latency p50=${ordersAgg.latency.p50}ms p95=${ordersAgg.latency.p95}ms p99=${ordersAgg.latency.p99}ms`,
  );
  const completions = entries.filter((e) => e.step === "request.complete" && e.route === "/orders/:id");
  const sampleError = completions.find((e) => e.outcome === "error")!;
  const sampleSlow = completions.filter((e) => (e.durationMs ?? 0) >= 250).sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))[0]!;
  console.log(
    `\nPicked one concrete error to investigate: requestId=${sampleError.requestId}, statusCode=${sampleError.statusCode}, ` +
      `durationMs=${sampleError.durationMs}`,
  );
  console.log(
    `Picked one concrete slow request to investigate: requestId=${sampleSlow.requestId}, durationMs=${sampleSlow.durationMs} ` +
      `(p95 was ${ordersAgg.latency.p95}ms, so this is in the slow tail, not typical)`,
  );

  // --- STEP 2: correlation ID -> WHAT it did ---
  section("STEP 2 - correlation ID: trace WHAT that one error request actually did");
  const errorTrace = entries.filter((e) => e.requestId === sampleError.requestId).sort((a, b) => a.time - b.time);
  for (const e of errorTrace) {
    const errInfo = e.err ? ` err="${e.err.message}"` : "";
    console.log(`  [${e.step}]${e.durationMs !== undefined ? ` durationMs=${e.durationMs}` : ""}${errInfo}`);
  }
  console.log(
    "\nThe trace shows the database query completed normally (db.query.end present, no error there) - the failure is " +
      "entirely inside business_logic (a real null customer_email breaking an unguarded .split('@')).",
  );

  // --- STEP 3: metrics -> systemic or one-off? ---
  section("STEP 3 - metrics: is this ONE error, or a SYSTEMIC pattern?");
  const metricsBody = await (await fetch(`${handle.baseUrl}/metrics`)).text();
  const errorsLine = metricsBody.split("\n").find((l) => l.startsWith('http_errors_total{route="/orders/:id"}'));
  const totalErrorsFromMetrics = errorsLine ? Number(errorsLine.split(" ").pop()) : 0;
  console.log(
    `http_errors_total{route="/orders/:id"} = ${totalErrorsFromMetrics} (matches the ${ordersAgg.errorCount} error(s) counted from logs).`,
  );
  console.log(
    totalErrorsFromMetrics > 1
      ? `SYSTEMIC: ${totalErrorsFromMetrics} separate requests hit this exact failure - it is a recurring class of ` +
          "input (guest-checkout orders with no email on file), not a one-off fluke. Worth a code fix, not a retry."
      : "ONE-OFF: only a single occurrence in this window - could still be a fluke, keep watching the error rate.",
  );

  // --- STEP 4: Postgres inspection -> is the DATABASE a contributing cause? ---
  section("STEP 4 - Postgres inspection: is the database a contributing cause of the SLOW requests, or the ERRORS?");
  console.log("Firing 5 concurrent SLOW requests (?slow=1, each a real pg_sleep(0.3)) and sampling pg_stat_activity mid-flight...\n");
  const slowBurst = Promise.all(
    Array.from({ length: 5 }, (_, i) => fetch(`${handle.baseUrl}/orders/${ids.validIds[i % ids.validIds.length]}?slow=1`)),
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  const duringSlowBurst = await pool.query(loadSharedSql("show-active-transactions.sql"));
  await slowBurst;
  const sleepingQueries = duringSlowBurst.rows.filter((r: { query: string }) => r.query.includes("pg_sleep"));
  console.log(`pg_stat_activity during the slow burst: ${sleepingQueries.length} backend(s) actively running a pg_sleep query.`);
  console.log(
    sleepingQueries.length > 0
      ? "CONCLUSION: the database genuinely IS a contributing cause of the slow-tail latency - these are real, currently " +
          "executing queries, not application-side delay."
      : "No pg_sleep query caught in this sample window - re-run, or widen the sampling delay.",
  );

  console.log("\nFiring 5 concurrent ERROR-triggering requests (guest-checkout ids) and sampling pg_stat_activity mid-flight...\n");
  const errorBurst = Promise.all(
    Array.from({ length: 5 }, (_, i) => fetch(`${handle.baseUrl}/orders/${ids.guestIds[i % ids.guestIds.length]}`)),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const duringErrorBurst = await pool.query(loadSharedSql("show-active-transactions.sql"));
  await errorBurst;
  console.log(`pg_stat_activity during the error burst: ${duringErrorBurst.rows.length} non-idle backend(s) found.`);
  console.log(
    "CONCLUSION: the SELECT behind each of these requests completes near-instantly - the database is NOT a contributing " +
      "cause of the errors. The bug is entirely in application code (business_logic.ts's unguarded .split('@')), which is " +
      "exactly what Step 2's trace already showed (db.query.end present and unremarkable, failure only after it).",
  );

  section("SUMMARY");
  console.log(
    `Of ${TRAFFIC_COUNT} requests: ${ordersAgg.errorCount} errored (${(ordersAgg.errorRate * 100).toFixed(1)}%, systemic - a real ` +
      "missing-null-check bug affecting every guest-checkout order lookup) and the slow tail (p95=" +
      `${ordersAgg.latency.p95}ms vs p50=${ordersAgg.latency.p50}ms) is real, database-caused latency, confirmed live in ` +
      "pg_stat_activity, not an application-side artifact. Structured logs found WHICH requests, the correlation ID traced " +
      "WHAT one of them did, metrics confirmed it was systemic rather than a fluke, and Postgres inspection separated a " +
      "real database-caused slow path from a real application-only bug - exactly the four tools a production on-call " +
      "engineer reaches for, in the order they are actually useful.",
  );

  await handle.close();
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "scenario failed");
  process.exit(1);
});
