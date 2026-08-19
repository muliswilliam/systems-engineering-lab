import { generateCustomers, generateOrdersBatched, generateProducts } from "@labs/data-generators";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { customers, orderLines, orders, products } from "../db/schema.js";

const log = createLogger("lab04:seed");

type Size = "small" | "medium" | "large";

interface Preset {
  customers: number;
  products: number;
  maxOrdersPerCustomer: number;
}

/**
 * Row-count math per customer (used to pick sizes and to translate
 * --rows=N into a customer count below): `maxOrdersPerCustomer` is a
 * uniform-random upper bound on orders/customer, so the mean is
 * `maxOrdersPerCustomer / 2`. Each order has a uniform 1-5 lines, mean 3.
 * So expected (orders + order_lines) rows per customer is roughly
 * `(maxOrdersPerCustomer / 2) * (1 + 3) = maxOrdersPerCustomer * 2`.
 *
 * - small:  300 customers   -> ~1.8k orders+lines.   Fast; safe default.
 * - medium: 5,000 customers -> ~80k orders+lines.     A middle step.
 * - large:  60,000 customers, maxOrdersPerCustomer=10 -> ~300k orders,
 *   ~900k order_lines, ~1.2M combined. This is the size this lab's README
 *   numbers were captured against. It is NOT a default a learner runs by
 *   accident - see README "Setup" for the expected wall-clock time.
 */
const SIZE_PRESETS: Record<Size, Preset> = {
  small: { customers: 300, products: 80, maxOrdersPerCustomer: 6 },
  medium: { customers: 5_000, products: 200, maxOrdersPerCustomer: 8 },
  large: { customers: 60_000, products: 500, maxOrdersPerCustomer: 10 },
};

const ROWS_MAX_ORDERS_PER_CUSTOMER = 10;
const ROWS_PER_CUSTOMER_ESTIMATE = ROWS_MAX_ORDERS_PER_CUSTOMER * 2;

function parseArgs(): { seed: number; preset: Preset; label: string } {
  const args = process.argv.slice(2);
  const seedArg = args.find((a) => a.startsWith("--seed="));
  const sizeArg = args.find((a) => a.startsWith("--size="));
  const rowsArg = args.find((a) => a.startsWith("--rows="));
  const seed = seedArg ? Number(seedArg.split("=")[1]) : 42;

  if (rowsArg) {
    const rows = Number(rowsArg.split("=")[1]);
    if (!Number.isFinite(rows) || rows <= 0) {
      throw new Error(`Invalid --rows value "${rowsArg}"`);
    }
    const customerCount = Math.max(1, Math.ceil(rows / ROWS_PER_CUSTOMER_ESTIMATE));
    const preset: Preset = {
      customers: customerCount,
      products: Math.max(200, Math.ceil(customerCount / 100)),
      maxOrdersPerCustomer: ROWS_MAX_ORDERS_PER_CUSTOMER,
    };
    return { seed, preset, label: `--rows=${rows} (~${customerCount} customers)` };
  }

  const size = (sizeArg ? sizeArg.split("=")[1] : "small") as Size;
  if (!(size in SIZE_PRESETS)) {
    throw new Error(`Unknown --size "${size}". Use small, medium, or large.`);
  }
  return { seed, preset: SIZE_PRESETS[size], label: `--size=${size}` };
}

/** Inserts `rows` in chunks of `chunkSize`, staying well under Postgres's
 * 65535-bind-parameter-per-statement limit regardless of how large `rows`
 * is (SPEC.md 8.4: batch/stream large inserts instead of one giant
 * statement or holding everything in memory). */
async function insertInBatches<T>(
  rows: T[],
  chunkSize: number,
  insertFn: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    await insertFn(rows.slice(i, i + chunkSize));
  }
}

const CUSTOMER_BATCH_SIZE = 5_000;
const PRODUCT_BATCH_SIZE = 5_000;
const ORDER_BATCH_SIZE = 2_000; // orders have 3 insert columns -> 6k params/batch
const PROGRESS_EVERY_BATCHES = 25;

async function main() {
  const { seed, preset, label } = parseArgs();
  const startedAt = Date.now();

  await waitForDatabase(pool);

  log.info({ seed, ...preset, label }, "clearing existing rows");
  await db.delete(orderLines);
  await db.delete(orders);
  await db.delete(products);
  await db.delete(customers);

  log.info({ count: preset.customers }, "generating and inserting customers");
  const generatedCustomers = generateCustomers(preset.customers, seed);
  const insertedCustomerIds: number[] = [];
  await insertInBatches(generatedCustomers, CUSTOMER_BATCH_SIZE, async (chunk) => {
    const inserted = await db
      .insert(customers)
      .values(
        chunk.map((c) => ({
          publicId: c.publicId,
          fullName: c.fullName,
          email: c.email,
          country: c.country,
        })),
      )
      .returning({ id: customers.id });
    insertedCustomerIds.push(...inserted.map((r) => r.id));
  });

  log.info({ count: preset.products }, "generating and inserting products");
  const generatedProducts = generateProducts(preset.products, seed);
  const insertedProductIds: number[] = [];
  await insertInBatches(generatedProducts, PRODUCT_BATCH_SIZE, async (chunk) => {
    const inserted = await db
      .insert(products)
      .values(
        chunk.map((p) => ({
          publicId: p.publicId,
          sku: p.sku,
          name: p.name,
          category: p.category,
          unitPriceCents: p.unitPriceCents,
        })),
      )
      .returning({ id: products.id });
    insertedProductIds.push(...inserted.map((r) => r.id));
  });

  log.info(
    { maxOrdersPerCustomer: preset.maxOrdersPerCustomer },
    "streaming orders + order_lines in batches (this is the part that takes real time at --size=large)",
  );

  let orderCount = 0;
  let orderLineCount = 0;
  let batchIndex = 0;

  for (const orderBatch of generateOrdersBatched({
    customers: generatedCustomers,
    products: generatedProducts,
    maxOrdersPerCustomer: preset.maxOrdersPerCustomer,
    seed,
    batchSize: ORDER_BATCH_SIZE,
  })) {
    const insertedOrders = await db
      .insert(orders)
      .values(
        orderBatch.map((o) => ({
          customerId: insertedCustomerIds[o.customerIndex]!,
          status: o.status,
          placedAt: o.placedAt,
        })),
      )
      .returning({ id: orders.id });

    const lineRows = orderBatch.flatMap((order, orderIndexInBatch) =>
      order.lines.map((line) => ({
        orderId: insertedOrders[orderIndexInBatch]!.id,
        productId: insertedProductIds[line.productIndex]!,
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
    batchIndex += 1;

    if (batchIndex % PROGRESS_EVERY_BATCHES === 0) {
      log.info(
        { batchIndex, orderCount, orderLineCount, elapsedMs: Date.now() - startedAt },
        "seed progress",
      );
    }
  }

  const elapsedMs = Date.now() - startedAt;
  log.info(
    {
      seed,
      customers: insertedCustomerIds.length,
      products: insertedProductIds.length,
      orders: orderCount,
      orderLines: orderLineCount,
      totalOrdersAndLines: orderCount + orderLineCount,
      elapsedMs,
      rowsPerSecond: Math.round((orderCount + orderLineCount) / (elapsedMs / 1000)),
    },
    "seed complete",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
