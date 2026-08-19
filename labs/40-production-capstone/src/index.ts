import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { seats, orders, outboxEvents } from "./db/schema.js";
import { startMetricsServer } from "./lib/metrics.js";

const log = createLogger("lab40:dev");

async function main() {
  await waitForDatabase(pool);

  const metricsPort = Number(process.env.METRICS_PORT ?? 9440);
  startMetricsServer(metricsPort);

  const seatCounts = await db
    .select({ status: seats.status, count: sql<number>`count(*)::int` })
    .from(seats)
    .groupBy(seats.status);
  const orderCount = await db.select({ count: sql<number>`count(*)::int` }).from(orders);
  const outboxCounts = await db
    .select({ status: outboxEvents.status, count: sql<number>`count(*)::int` })
    .from(outboxEvents)
    .groupBy(outboxEvents.status);

  log.info(
    { seatCounts, orderCount: orderCount[0]?.count ?? 0, outboxCounts, metricsUrl: `http://localhost:${metricsPort}/metrics` },
    "current database state - run a `pnpm scenario:*` script or `pnpm test` next; metrics server stays up until Ctrl-C",
  );
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
