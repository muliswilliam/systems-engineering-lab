import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { inventoryItems, orders, sagaLog } from "./db/schema.js";

const log = createLogger("lab20:dev");

async function main() {
  await waitForDatabase(pool);

  const inventory = await db
    .select({ sku: inventoryItems.sku, availableQuantity: inventoryItems.availableQuantity })
    .from(inventoryItems)
    .orderBy(inventoryItems.sku);

  const ordersByStatus = await db
    .select({ status: orders.status, count: sql<number>`count(*)::int` })
    .from(orders)
    .groupBy(orders.status);

  const sagaLogByMechanism = await db
    .select({
      mechanism: sagaLog.mechanism,
      outcome: sagaLog.outcome,
      count: sql<number>`count(*)::int`,
    })
    .from(sagaLog)
    .groupBy(sagaLog.mechanism, sagaLog.outcome);

  log.info({ inventory, ordersByStatus, sagaLogByMechanism }, "current database state");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
