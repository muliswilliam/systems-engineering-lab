import { generateCustomers, generateProducts, generateOrders } from "@labs/data-generators";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { customers, products, orders, orderLines } from "../db/schema.js";

const log = createLogger("lab03:seed");

type Size = "small" | "medium" | "large";

const SIZE_PRESETS: Record<Size, { customers: number; products: number; maxOrdersPerCustomer: number }> = {
  small: { customers: 300, products: 80, maxOrdersPerCustomer: 6 },
  medium: { customers: 2000, products: 200, maxOrdersPerCustomer: 8 },
  large: { customers: 8000, products: 400, maxOrdersPerCustomer: 10 },
};

function parseArgs(): { seed: number; size: Size } {
  const args = process.argv.slice(2);
  const seedArg = args.find((a) => a.startsWith("--seed="));
  const sizeArg = args.find((a) => a.startsWith("--size="));
  const seed = seedArg ? Number(seedArg.split("=")[1]) : 42;
  const size = (sizeArg ? sizeArg.split("=")[1] : "small") as Size;

  if (!(size in SIZE_PRESETS)) {
    throw new Error(`Unknown --size "${size}". Use small, medium, or large.`);
  }

  return { seed, size };
}

const BATCH_SIZE = 500;

async function main() {
  const { seed, size } = parseArgs();
  const preset = SIZE_PRESETS[size];

  await waitForDatabase(pool);

  log.info({ seed, size }, "clearing existing rows");
  await db.delete(orderLines);
  await db.delete(orders);
  await db.delete(products);
  await db.delete(customers);

  const generatedCustomers = generateCustomers(preset.customers, seed);
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

  const generatedProducts = generateProducts(preset.products, seed);
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

  const generatedOrders = generateOrders(
    generatedCustomers,
    generatedProducts,
    preset.maxOrdersPerCustomer,
    seed,
  );

  let orderCount = 0;
  let orderLineCount = 0;

  for (let i = 0; i < generatedOrders.length; i += BATCH_SIZE) {
    const batch = generatedOrders.slice(i, i + BATCH_SIZE);

    const insertedOrders = await db
      .insert(orders)
      .values(
        batch.map((o) => ({
          customerId: insertedCustomers[o.customerIndex]!.id,
          status: o.status,
          placedAt: o.placedAt,
        })),
      )
      .returning({ id: orders.id });

    const lineRows = batch.flatMap((order, orderIndexInBatch) =>
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

    orderCount += insertedOrders.length;
    orderLineCount += lineRows.length;
  }

  const customersWithNoOrders = preset.customers - new Set(generatedOrders.map((o) => o.customerIndex)).size;

  log.info(
    {
      customers: insertedCustomers.length,
      products: insertedProducts.length,
      orders: orderCount,
      orderLines: orderLineCount,
      customersWithNoOrders,
    },
    "seed complete",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
