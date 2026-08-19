import { eq, isNull, sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { customers, orders, orderLines, products } from "../db/schema.js";

const log = createLogger("lab03:demo:joins");

/**
 * Two join shapes:
 *
 * 1. An INNER JOIN across all four tables (customers -> orders ->
 *    order_lines -> products) - the "detail line" report every commerce
 *    system needs somewhere.
 * 2. A LEFT JOIN that finds customers with zero orders - a query that is
 *    only possible because the seed generator deliberately leaves some
 *    customers order-less (see @labs/data-generators/commerce.ts).
 *
 * Each is run once through the Drizzle query builder and once as raw SQL
 * against the same pool, and the two are compared for agreement.
 */
async function main() {
  await waitForDatabase(pool);

  // --- 1. Inner join across all four tables ---

  const drizzleDetailRows = await db
    .select({
      orderPublicId: orders.publicId,
      customerName: customers.fullName,
      productName: products.name,
      quantity: orderLines.quantity,
      lineTotalCents: orderLines.lineTotalCents,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .innerJoin(products, eq(orderLines.productId, products.id))
    .orderBy(orderLines.id)
    .limit(5);

  log.info({ sample: drizzleDetailRows }, "Drizzle: order line detail (inner join x3)");

  const rawDetailResult = await pool.query(
    `SELECT
       o.public_id  AS "orderPublicId",
       c.full_name  AS "customerName",
       p.name       AS "productName",
       ol.quantity,
       ol.line_total_cents AS "lineTotalCents"
     FROM order_lines ol
     JOIN orders o    ON o.id = ol.order_id
     JOIN customers c ON c.id = o.customer_id
     JOIN products p  ON p.id = ol.product_id
     ORDER BY ol.id
     LIMIT 5`,
  );

  log.info({ sample: rawDetailResult.rows }, "raw SQL: order line detail (inner join x3)");

  const [drizzleDetailCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .innerJoin(products, eq(orderLines.productId, products.id));

  const rawDetailCount = await pool.query<{ count: string }>(
    `SELECT count(*)::int AS count
     FROM order_lines ol
     JOIN orders o    ON o.id = ol.order_id
     JOIN customers c ON c.id = o.customer_id
     JOIN products p  ON p.id = ol.product_id`,
  );

  log.info(
    {
      drizzleCount: drizzleDetailCount?.count,
      rawCount: Number(rawDetailCount.rows[0]?.count),
      agree: drizzleDetailCount?.count === Number(rawDetailCount.rows[0]?.count),
    },
    "inner join row counts agree",
  );

  // --- 2. Left join to find customers with no orders ---

  const drizzleNoOrderCustomers = await db
    .select({ id: customers.id, fullName: customers.fullName })
    .from(customers)
    .leftJoin(orders, eq(orders.customerId, customers.id))
    .where(isNull(orders.id));

  const rawNoOrderCustomers = await pool.query(
    `SELECT c.id, c.full_name AS "fullName"
     FROM customers c
     LEFT JOIN orders o ON o.customer_id = c.id
     WHERE o.id IS NULL`,
  );

  log.info(
    {
      drizzleCount: drizzleNoOrderCustomers.length,
      rawCount: rawNoOrderCustomers.rowCount,
      agree: drizzleNoOrderCustomers.length === rawNoOrderCustomers.rowCount,
      sample: drizzleNoOrderCustomers.slice(0, 3),
    },
    "left join: customers with zero orders",
  );

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "joins demo failed");
  process.exit(1);
});
