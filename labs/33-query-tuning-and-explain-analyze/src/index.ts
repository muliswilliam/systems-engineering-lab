import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { customers, products, orders, orderLines } from "./db/schema.js";

const log = createLogger("lab33:dev");

async function main() {
  await waitForDatabase(pool);

  const [customerCount] = await db.select({ count: sql<number>`count(*)::int` }).from(customers);
  const [productCount] = await db.select({ count: sql<number>`count(*)::int` }).from(products);
  const [orderCount] = await db.select({ count: sql<number>`count(*)::int` }).from(orders);
  const [orderLineCount] = await db.select({ count: sql<number>`count(*)::int` }).from(orderLines);

  const indexResult = await pool.query<{ indexname: string; tablename: string }>(
    `SELECT indexname, tablename FROM pg_indexes
     WHERE schemaname = 'public' AND indexname LIKE 'idx_%'
     ORDER BY tablename, indexname`,
  );

  const statsResult = await pool.query<{ stxname: string }>(
    `SELECT stxname FROM pg_statistic_ext ORDER BY stxname`,
  );

  const statusResult = await pool.query<{ status: string; channel: string; count: string }>(
    `SELECT status, channel, count(*) AS count FROM orders GROUP BY status, channel ORDER BY status, channel`,
  );

  log.info(
    {
      customers: customerCount?.count ?? 0,
      products: productCount?.count ?? 0,
      orders: orderCount?.count ?? 0,
      orderLines: orderLineCount?.count ?? 0,
      totalOrdersAndLines: (orderCount?.count ?? 0) + (orderLineCount?.count ?? 0),
      performanceIndexes: indexResult.rows,
      extendedStatistics: statsResult.rows.map((r) => r.stxname),
      statusChannelDistribution: statusResult.rows,
    },
    "current database state",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
