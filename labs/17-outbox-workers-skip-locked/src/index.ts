import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { outboxEvents, processedEvents } from "./db/schema.js";

const log = createLogger("lab17:dev");

async function main() {
  await waitForDatabase(pool);

  const statusCounts = await db
    .select({ status: outboxEvents.status, count: sql<number>`count(*)::int` })
    .from(outboxEvents)
    .groupBy(outboxEvents.status);

  const [processedCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(processedEvents);

  log.info(
    { statusCounts, processedEventsCount: processedCount?.count ?? 0 },
    "current database state",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
