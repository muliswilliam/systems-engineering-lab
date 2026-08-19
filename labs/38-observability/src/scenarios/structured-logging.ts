import "dotenv/config";
import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { startLabServer } from "./harness.js";
import { generateTraffic, loadIdPools, summarizeTraffic } from "./traffic-generator.js";
import { parseStructuredLog, aggregateByRoute, attemptNaiveLogParse } from "../observability/log-analysis.js";

const log = createLogger("lab38:scenario:structured-logging");

const TRAFFIC_COUNT = 300;
const SEED = 38;

async function main() {
  await waitForDatabase(pool);
  const ids = await loadIdPools(pool);
  if (ids.validIds.length === 0 || ids.guestIds.length === 0) {
    throw new Error("Run `pnpm seed` first - no orders found (need both real-email and guest rows).");
  }

  const port = Number(process.env.APP_PORT ?? 4438) + 10; // distinct from the dev server Prometheus scrapes
  const structuredLogFile = process.env.STRUCTURED_LOG_FILE ?? "logs/structured.log";
  const naiveLogFile = process.env.NAIVE_LOG_FILE ?? "logs/naive.log";
  const handle = await startLabServer(pool, port, structuredLogFile, naiveLogFile);

  console.log(`\n--- structured logging vs. unstructured logging: ${TRAFFIC_COUNT} real requests ---\n`);
  const results = await generateTraffic(handle.baseUrl, TRAFFIC_COUNT, SEED, ids);
  const mix = summarizeTraffic(results);
  await handle.flushLogs();
  await handle.close();

  log.info({ mix }, "real traffic mix sent");

  const entries = parseStructuredLog(handle.structuredLogFile);
  const aggregates = aggregateByRoute(entries);

  console.log("\n=== REAL aggregates computed from structured.log (one JSON.parse per line + group-by) ===\n");
  for (const agg of aggregates) {
    console.log(
      `${agg.route.padEnd(12)} total=${agg.total.toString().padEnd(4)} errorRate=${(agg.errorRate * 100).toFixed(1)}%  ` +
        `p50=${agg.latency.p50}ms p95=${agg.latency.p95}ms p99=${agg.latency.p99}ms (min=${agg.latency.min}ms max=${agg.latency.max}ms)`,
    );
  }

  const overallTotal = aggregates.reduce((sum, a) => sum + a.total, 0);
  const overallErrors = aggregates.reduce((sum, a) => sum + a.errorCount, 0);
  console.log(
    `\nOverall: ${overallTotal} completed requests, ${overallErrors} errors, error rate ${((overallErrors / overallTotal) * 100).toFixed(2)}%`,
  );

  console.log("\n=== Attempting the SAME aggregate from naive.log's free-text lines ===\n");
  const naiveResult = attemptNaiveLogParse(handle.naiveLogFile);
  console.log(
    `naive.log: ${naiveResult.totalLines} total lines, ${naiveResult.successfullyParsed} matched a single hand-written regex, ` +
      `${naiveResult.failedToParse} lines silently dropped from the aggregate (different format, or an ERROR line with no duration), ` +
      `${naiveResult.wronglyClassifiedAsSuccess} of the matched lines had NO way to express outcome so were implicitly treated as success.`,
  );
  console.log(
    "\nCONCLUSION: the structured aggregate above is EXACT (every one of the " +
      `${overallTotal} requests is accounted for, by route, by outcome). The naive aggregate ` +
      `is not just incomplete (${naiveResult.failedToParse}/${naiveResult.totalLines} lines unusable) - the ` +
      `lines it DOES parse cannot even express whether the request succeeded, because the free-text ` +
      "format never named that field in the first place.",
  );

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "scenario failed");
  process.exit(1);
});
