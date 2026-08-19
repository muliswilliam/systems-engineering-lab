import { Faker, en } from "@faker-js/faker";
import { generateCustomers, generateOrdersBatched, generateProducts } from "@labs/data-generators";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { customers, orderLines, orders, products } from "../db/schema.js";
import { pickChannel } from "./generate-channel.js";

const log = createLogger("lab33:seed");

type Size = "small" | "medium" | "large";

interface Preset {
  customers: number;
  products: number;
  maxOrdersPerCustomer: number;
}

/**
 * Same row-count math Lab 04 documents: `maxOrdersPerCustomer` is a
 * uniform-random upper bound, mean orders/customer is half of it, mean
 * lines/order is ~3, so expected (orders + order_lines) rows per customer is
 * roughly `maxOrdersPerCustomer * 2`.
 *
 * - small:  300 customers    -> ~1.8k orders+lines.  Fast sanity check.
 * - medium: 5,000 customers  -> ~80k orders+lines.    A middle step.
 * - large:  40,000 customers, maxOrdersPerCustomer=10 -> ~200k orders,
 *   ~600k order_lines, ~800k combined - comfortably over SPEC.md's
 *   "tens of thousands to ~100k+ rows" target for THIS lab (which needs
 *   real, measurable query-plan differences, not 1M+ rows the way Lab 04's
 *   write-amplification demo needed). This is NOT the default - see README
 *   "Setup" for expected wall-clock time.
 */
const SIZE_PRESETS: Record<Size, Preset> = {
  small: { customers: 300, products: 80, maxOrdersPerCustomer: 6 },
  medium: { customers: 5_000, products: 200, maxOrdersPerCustomer: 8 },
  large: { customers: 40_000, products: 400, maxOrdersPerCustomer: 10 },
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

/** Inserts `rows` in chunks of `chunkSize` (SPEC.md 8.4: batch/stream large
 * inserts instead of one giant statement or holding everything in memory). */
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
const ORDER_BATCH_SIZE = 2_000;
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
    "streaming orders + order_lines in batches (channel assigned locally, correlated with status)",
  );

  const channelFaker = new Faker({ locale: en });
  channelFaker.seed(seed + 3);

  let orderCount = 0;
  let orderLineCount = 0;
  let batchIndex = 0;
  const channelCounts: Record<string, number> = { web: 0, mobile: 0, phone: 0, store: 0 };
  const statusCounts: Record<string, number> = {};

  for (const orderBatch of generateOrdersBatched({
    customers: generatedCustomers,
    products: generatedProducts,
    maxOrdersPerCustomer: preset.maxOrdersPerCustomer,
    seed,
    batchSize: ORDER_BATCH_SIZE,
  })) {
    const channels = orderBatch.map((o) => pickChannel(channelFaker, o.status));
    channels.forEach((c) => {
      channelCounts[c] = (channelCounts[c] ?? 0) + 1;
    });
    orderBatch.forEach((o) => {
      statusCounts[o.status] = (statusCounts[o.status] ?? 0) + 1;
    });

    const insertedOrders = await db
      .insert(orders)
      .values(
        orderBatch.map((o, i) => ({
          customerId: insertedCustomerIds[o.customerIndex]!,
          status: o.status,
          channel: channels[i]!,
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

  log.info({ statusCounts, channelCounts }, "seeded status/channel distribution (before any scenario mutates it)");

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

  log.info("running ANALYZE so a freshly-seeded database starts with accurate planner statistics");
  await pool.query("ANALYZE customers, products, orders, order_lines");

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
