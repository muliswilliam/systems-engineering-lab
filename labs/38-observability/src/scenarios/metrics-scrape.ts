import "dotenv/config";
import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { startLabServer } from "./harness.js";
import { generateTraffic, loadIdPools } from "./traffic-generator.js";

const log = createLogger("lab38:scenario:metrics");

const TRAFFIC_COUNT = 250;
const SEED = 38;

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

  console.log(`\n--- sending ${TRAFFIC_COUNT} real requests, then scraping /metrics for real ---\n`);
  const results = await generateTraffic(handle.baseUrl, TRAFFIC_COUNT, SEED, ids);
  await handle.flushLogs();

  // The real scrape: an actual HTTP GET against the running service's own
  // /metrics endpoint, exactly what a Prometheus server does every
  // `scrape_interval` (see prometheus/prometheus.yml).
  const scrapeResponse = await fetch(`${handle.baseUrl}/metrics`);
  const body = await scrapeResponse.text();

  console.log(`GET ${handle.baseUrl}/metrics -> ${scrapeResponse.status} (${body.length} bytes, content-type: ${scrapeResponse.headers.get("content-type")})\n`);

  console.log("=== Sample of the REAL scraped Prometheus text format ===\n");
  const relevantLines = body
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("http_requests_total") ||
        line.startsWith("http_errors_total") ||
        line.startsWith("http_requests_in_flight") ||
        line.startsWith("db_pool_") ||
        (line.startsWith("http_request_duration_seconds_bucket") && line.includes('route="/orders/:id"')),
    );
  console.log(relevantLines.join("\n"));

  const totalFromMetrics = relevantLines
    .filter((l) => l.startsWith("http_requests_total{"))
    .reduce((sum, line) => sum + Number(line.split(" ").pop()), 0);

  console.log(
    `\nReal requests sent: ${results.length}. Sum of http_requests_total{...} series parsed back out of the scrape: ${totalFromMetrics}.`,
  );
  console.log(
    totalFromMetrics === results.length
      ? "MATCH - the counter's total across every label combination equals the exact number of requests made."
      : "MISMATCH - see README 'Break it' for what this would mean in a real incident.",
  );

  await handle.close();
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "scenario failed");
  process.exit(1);
});
