import { generateCustomers, generateOrdersBatched, generateProducts } from "@labs/data-generators";
import { db, pool } from "../../src/db/client.js";
import { customers, orderLines, orders, products } from "../../src/db/schema.js";

/**
 * Small, deterministic dataset shared by this lab's integration tests -
 * same generators and seed constant as `pnpm seed`, just sized for fast
 * test runs. This lab's tests assert structural facts about query plans
 * (which index gets used, whether results match with/without an index),
 * not timing or planner-choice-by-default - see plans.test.ts for why: on a
 * dataset this small, Postgres's planner correctly prefers a sequential
 * scan over an index scan regardless of whether the index exists, because
 * the table fits in a handful of pages. Tests force the planner's hand with
 * `SET LOCAL enable_seqscan/enable_indexscan/...` instead of relying on
 * default cost-based choices, which is also a genuinely useful production
 * debugging technique (see README "Observe").
 */
export async function seedTestData(): Promise<void> {
  await db.delete(orderLines);
  await db.delete(orders);
  await db.delete(products);
  await db.delete(customers);

  const generatedCustomers = generateCustomers(200, 42);
  const insertedCustomers = await db
    .insert(customers)
    .values(
      generatedCustomers.map((c) => ({
        publicId: c.publicId,
        fullName: c.fullName,
        email: c.email,
        country: c.country,
      })),
    )
    .returning({ id: customers.id });

  const generatedProducts = generateProducts(50, 42);
  const insertedProducts = await db
    .insert(products)
    .values(
      generatedProducts.map((p) => ({
        publicId: p.publicId,
        sku: p.sku,
        name: p.name,
        category: p.category,
        unitPriceCents: p.unitPriceCents,
      })),
    )
    .returning({ id: products.id });

  for (const orderBatch of generateOrdersBatched({
    customers: generatedCustomers,
    products: generatedProducts,
    maxOrdersPerCustomer: 8,
    seed: 42,
    batchSize: 500,
  })) {
    const insertedOrders = await db
      .insert(orders)
      .values(
        orderBatch.map((o) => ({
          customerId: insertedCustomers[o.customerIndex]!.id,
          status: o.status,
          placedAt: o.placedAt,
        })),
      )
      .returning({ id: orders.id });

    const lineRows = orderBatch.flatMap((order, orderIndexInBatch) =>
      order.lines.map((line) => ({
        orderId: insertedOrders[orderIndexInBatch]!.id,
        productId: insertedProducts[line.productIndex]!.id,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        lineTotalCents: line.lineTotalCents,
      })),
    );

    if (lineRows.length > 0) {
      await db.insert(orderLines).values(lineRows);
    }
  }

  // Index Only Scan requires the visibility map to mark pages all-visible -
  // that normally happens via (auto)VACUUM, which may not have run yet
  // immediately after a bulk insert in a fresh test database. Without this,
  // the covering-index test below could flake between "Index Scan" and
  // "Index Only Scan" depending on autovacuum timing.
  await pool.query("VACUUM ANALYZE order_lines, orders, customers, products");
}
