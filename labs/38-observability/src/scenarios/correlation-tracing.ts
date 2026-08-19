import "dotenv/config";
import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { startLabServer } from "./harness.js";
import { loadIdPools } from "./traffic-generator.js";
import { parseStructuredLog } from "../observability/log-analysis.js";

const log = createLogger("lab38:scenario:tracing");

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

  const fastId = ids.validIds[0];
  const slowId = ids.validIds[1] ?? ids.validIds[0];
  const errorId = ids.guestIds[0];

  const requests = [
    { requestId: "trace-fast-1", path: `/orders/${fastId}` },
    { requestId: "trace-slow-1", path: `/orders/${slowId}?slow=1` },
    { requestId: "trace-error-1", path: `/orders/${errorId}` },
    { requestId: "trace-notfound-1", path: "/orders/9999999" },
    { requestId: "trace-fast-2", path: `/orders/${fastId}` },
  ];

  console.log(`\n--- firing ${requests.length} CONCURRENT requests, each with its own x-request-id header ---\n`);

  // Fired concurrently on purpose: this is what makes the log file's lines
  // interleave across requests, exactly like a real production service
  // under real concurrent load. If you can still recover ONE request's
  // full path afterward, correlation IDs are doing real work.
  await Promise.all(
    requests.map((r) => fetch(`${handle.baseUrl}${r.path}`, { headers: { "x-request-id": r.requestId } })),
  );
  await handle.flushLogs();
  await handle.close();

  const entries = parseStructuredLog(handle.structuredLogFile);
  console.log(`Total log lines written across all ${requests.length} concurrent requests: ${entries.length}\n`);

  const target = "trace-error-1";
  const traced = entries.filter((e) => e.requestId === target).sort((a, b) => a.time - b.time);

  console.log(`=== Every log line for requestId="${target}" (grep -F '"requestId":"${target}"' ${handle.structuredLogFile}) ===\n`);
  for (const entry of traced) {
    const extra = entry.durationMs !== undefined ? ` durationMs=${entry.durationMs}` : "";
    const errInfo = entry.err ? ` err.message="${entry.err.message}"` : "";
    console.log(`  [${entry.step}] route=${entry.route}${extra}${errInfo}`);
  }

  console.log(
    `\n${traced.length} of ${entries.length} total lines belong to this ONE request - filtering by requestId reconstructs ` +
      "its exact path (request.start -> db.query.start/end -> business_logic.start -> [threw] -> request.complete) " +
      "even though 4 other requests' log lines were interleaved with it in the same file at the same time.",
  );

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "scenario failed");
  process.exit(1);
});
