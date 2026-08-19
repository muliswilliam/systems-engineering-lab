import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { orders, outboxEvents } from "./db/schema.js";

const log = createLogger("lab16:dev");

async function main() {
  await waitForDatabase(pool);

  const [orderCount] = await db.select({ count: sql<number>`count(*)::int` }).from(orders);
  const [outboxCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(outboxEvents);
  const [unpublishedCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(outboxEvents)
    .where(sql`published_at is null`);

  log.info(
    {
      orderCount: orderCount?.count ?? 0,
      outboxEventCount: outboxCount?.count ?? 0,
      unpublishedOutboxEventCount: unpublishedCount?.count ?? 0,
    },
    "current database state",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
