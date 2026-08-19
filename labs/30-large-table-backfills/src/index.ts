import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { orders } from "./db/schema.js";

const log = createLogger("lab30:dev");

async function main() {
  await waitForDatabase(pool);

  const [orderCount] = await db.select({ count: sql<number>`count(*)::int` }).from(orders);
  const [backfilled] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(sql`loyalty_points is not null`);

  const total = orderCount?.count ?? 0;
  const done = backfilled?.count ?? 0;

  log.info(
    {
      orderCount: total,
      loyaltyPointsBackfilled: done,
      loyaltyPointsRemaining: total - done,
      percentComplete: total === 0 ? 0 : Number(((done / total) * 100).toFixed(2)),
    },
    "current database state",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
