import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { deliveryLog, notifications } from "./db/schema.js";

const log = createLogger("lab19:dev");

async function main() {
  await waitForDatabase(pool);

  const [notificationCount] = await db.select({ count: sql<number>`count(*)::int` }).from(notifications);
  const [deliveryLogCount] = await db.select({ count: sql<number>`count(*)::int` }).from(deliveryLog);

  const byScenario = await db
    .select({
      scenario: notifications.scenario,
      status: notifications.status,
      count: sql<number>`count(*)::int`,
      totalDeliveryAttempts: sql<number>`coalesce(sum((
        select count(*)::int from delivery_log dl where dl.message_id = notifications.id
      )), 0)`,
      totalReceiverProcessedCount: sql<number>`coalesce(sum(${notifications.receiverProcessedCount}), 0)`,
    })
    .from(notifications)
    .groupBy(notifications.scenario, notifications.status);

  log.info(
    {
      notificationCount: notificationCount?.count ?? 0,
      deliveryLogCount: deliveryLogCount?.count ?? 0,
      byScenario,
    },
    "current database state",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
