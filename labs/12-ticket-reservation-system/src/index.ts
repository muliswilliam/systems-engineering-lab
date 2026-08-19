import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { events, seats } from "./db/schema.js";

const log = createLogger("lab12:dev");

async function main() {
  await waitForDatabase(pool);

  const eventRows = await db.select({ count: sql<number>`count(*)::int` }).from(events);
  const seatCountsByStatus = await db
    .select({ status: seats.status, count: sql<number>`count(*)::int` })
    .from(seats)
    .groupBy(seats.status);

  log.info(
    {
      eventCount: eventRows[0]?.count ?? 0,
      seatCountsByStatus,
    },
    "current database state",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
