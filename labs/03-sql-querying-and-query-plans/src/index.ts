import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { customers, products, orders, orderLines } from "./db/schema.js";

const log = createLogger("lab03:dev");

async function main() {
  await waitForDatabase(pool);

  const [customerCount] = await db.select({ count: sql<number>`count(*)::int` }).from(customers);
  const [productCount] = await db.select({ count: sql<number>`count(*)::int` }).from(products);
  const [orderCount] = await db.select({ count: sql<number>`count(*)::int` }).from(orders);
  const [orderLineCount] = await db.select({ count: sql<number>`count(*)::int` }).from(orderLines);

  log.info(
    {
      customers: customerCount?.count ?? 0,
      products: productCount?.count ?? 0,
      orders: orderCount?.count ?? 0,
      orderLines: orderLineCount?.count ?? 0,
    },
    "current database state",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
