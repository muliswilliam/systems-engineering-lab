import { generateCustomers, generateOrders, generateProducts } from "@labs/data-generators";
import { db } from "../../src/db/client.js";
import { customers, orderLines, orders, products } from "../../src/db/schema.js";

/**
 * Small, deterministic dataset shared by this lab's integration tests - the
 * same generators and seed constant `pnpm seed` uses, just at a size chosen
 * for fast test runs rather than for exploring query plans by hand.
 */
export async function seedTestData(): Promise<void> {
  await db.delete(orderLines);
  await db.delete(orders);
  await db.delete(products);
  await db.delete(customers);

  const generatedCustomers = generateCustomers(30, 42);
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

  const generatedProducts = generateProducts(15, 42);
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

  const generatedOrders = generateOrders(generatedCustomers, generatedProducts, 5, 42);

  for (const order of generatedOrders) {
    const [insertedOrder] = await db
      .insert(orders)
      .values({
        customerId: insertedCustomers[order.customerIndex]!.id,
        status: order.status,
        placedAt: order.placedAt,
      })
      .returning({ id: orders.id });

    if (order.lines.length > 0) {
      await db.insert(orderLines).values(
        order.lines.map((line) => ({
          orderId: insertedOrder!.id,
          productId: insertedProducts[line.productIndex]!.id,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          lineTotalCents: line.lineTotalCents,
        })),
      );
    }
  }
}
