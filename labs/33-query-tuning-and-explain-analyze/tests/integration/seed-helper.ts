import { Faker, en } from "@faker-js/faker";
import { generateCustomers, generateOrdersBatched, generateProducts } from "@labs/data-generators";
import { db, pool } from "../../src/db/client.js";
import { customers, orderLines, orders, products } from "../../src/db/schema.js";
import { pickChannel } from "../../src/seed/generate-channel.js";

/**
 * Small, deterministic dataset shared by this lab's integration tests -
 * same generators, same channel-correlation logic, and same seed constant
 * as `pnpm seed`, just sized for fast test runs. Big enough that Pattern
 * 1b's correlated-columns effect is still statistically real on this
 * dataset (a few hundred cancelled orders, most of them phone), small
 * enough that the whole suite runs in seconds.
 */
export async function seedTestData(): Promise<void> {
  await db.delete(orderLines);
  await db.delete(orders);
  await db.delete(products);
  await db.delete(customers);
  await pool.query("DROP STATISTICS IF EXISTS orders_status_channel_stats");

  const generatedCustomers = generateCustomers(600, 42);
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

  const generatedProducts = generateProducts(80, 42);
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

  const channelFaker = new Faker({ locale: en });
  channelFaker.seed(42 + 3);

  for (const orderBatch of generateOrdersBatched({
    customers: generatedCustomers,
    products: generatedProducts,
    maxOrdersPerCustomer: 8,
    seed: 42,
    batchSize: 500,
  })) {
    const channels = orderBatch.map((o) => pickChannel(channelFaker, o.status));

    const insertedOrders = await db
      .insert(orders)
      .values(
        orderBatch.map((o, i) => ({
          customerId: insertedCustomers[o.customerIndex]!.id,
          status: o.status,
          channel: channels[i]!,
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

  // Index Only Scan / accurate row-estimate tests both depend on fresh
  // statistics and an all-visible visibility map - neither is guaranteed
  // immediately after a bulk insert into a fresh test database.
  await pool.query("VACUUM ANALYZE orders, order_lines, customers, products");
}
