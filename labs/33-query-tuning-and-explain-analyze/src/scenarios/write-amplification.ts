import { performance } from "node:perf_hooks";
import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { ALL_INDEXES } from "./index-definitions.js";

const log = createLogger("lab33:scenario:write-amplification");

const DEFAULT_ORDER_COUNT = 20_000;
const BATCH_SIZE = 2_000;

function parseCount(): number {
  const arg = process.argv.slice(2).find((a) => a.startsWith("--count="));
  const count = arg ? Number(arg.split("=")[1]) : DEFAULT_ORDER_COUNT;
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error(`Invalid --count value "${arg}"`);
  }
  return count;
}

/**
 * Per CLAUDE.md's "Query Performance" section: do not add indexes blindly -
 * explain write amplification. This measures the combined insert cost of
 * this lab's 4 indexes together (idx_orders_status, idx_orders_placed_at,
 * idx_order_lines_order_id, idx_orders_month_expr), the same aggregate
 * measurement style Lab 04's own write-amplification.ts uses for its 6
 * indexes, run once with 0 of the 4 present and once with all 4 present.
 * `orders.channel`'s extended statistics object (CREATE STATISTICS) is
 * DELIBERATELY excluded from this measurement - it has no per-write
 * maintenance cost (there is no index structure to keep up to date on every
 * INSERT); its only cost is a slightly slower ANALYZE, not a slower write.
 */
async function countExistingIndexes(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)`,
    [ALL_INDEXES.map((i) => i.name)],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function main() {
  await waitForDatabase(pool);
  const orderCount = parseCount();

  const indexesPresent = await countExistingIndexes();
  const label = indexesPresent === ALL_INDEXES.length ? "after" : indexesPresent === 0 ? "before" : "partial";

  const { rows: customerRows } = await pool.query<{ id: string }>(
    "SELECT id FROM customers ORDER BY id LIMIT 1000",
  );
  const { rows: productRows } = await pool.query<{ id: string }>(
    "SELECT id FROM products ORDER BY id LIMIT 1000",
  );
  if (customerRows.length === 0 || productRows.length === 0) {
    throw new Error("no customers/products found - run `pnpm seed` first");
  }
  const customerIds = customerRows.map((r) => r.id);
  const productIds = productRows.map((r) => r.id);

  log.info(
    { orderCount, indexesPresent, totalIndexes: ALL_INDEXES.length, label },
    `starting write-amplification insert ("${label}"-indexes state, detected from pg_indexes)`,
  );

  const startedAt = performance.now();
  let insertedOrders = 0;
  let insertedLines = 0;

  for (let start = 0; start < orderCount; start += BATCH_SIZE) {
    const batchCount = Math.min(BATCH_SIZE, orderCount - start);
    const batchCustomerIds: string[] = [];
    const batchStatuses: string[] = [];
    const batchChannels: string[] = [];
    const batchPlacedAt: Date[] = [];

    for (let i = 0; i < batchCount; i += 1) {
      const globalIndex = start + i;
      batchCustomerIds.push(customerIds[globalIndex % customerIds.length]!);
      batchStatuses.push("paid");
      batchChannels.push("web");
      batchPlacedAt.push(new Date());
    }

    const orderResult = await pool.query<{ id: string }>(
      `INSERT INTO orders (customer_id, status, channel, placed_at)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::timestamptz[])
       RETURNING id`,
      [batchCustomerIds, batchStatuses, batchChannels, batchPlacedAt],
    );

    const lineOrderIds: string[] = [];
    const lineProductIds: string[] = [];
    const lineQuantities: number[] = [];
    const lineUnitPrices: number[] = [];
    const lineTotals: number[] = [];

    orderResult.rows.forEach((row, i) => {
      const globalIndex = start + i;
      const linesForOrder = (globalIndex % 3) + 1; // deterministic 1-3 lines per order
      for (let l = 0; l < linesForOrder; l += 1) {
        const productId = productIds[(globalIndex + l) % productIds.length]!;
        const quantity = (l % 4) + 1;
        const unitPriceCents = 1999;
        lineOrderIds.push(row.id);
        lineProductIds.push(productId);
        lineQuantities.push(quantity);
        lineUnitPrices.push(unitPriceCents);
        lineTotals.push(quantity * unitPriceCents);
      }
    });

    if (lineOrderIds.length > 0) {
      await pool.query(
        `INSERT INTO order_lines (order_id, product_id, quantity, unit_price_cents, line_total_cents)
         SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::int[], $4::int[], $5::int[])`,
        [lineOrderIds, lineProductIds, lineQuantities, lineUnitPrices, lineTotals],
      );
    }

    insertedOrders += orderResult.rows.length;
    insertedLines += lineOrderIds.length;
  }

  const elapsedMs = performance.now() - startedAt;
  const totalRows = insertedOrders + insertedLines;

  log.info(
    {
      label,
      indexesPresent,
      insertedOrders,
      insertedLines,
      totalRowsInserted: totalRows,
      elapsedMs: Math.round(elapsedMs),
      rowsPerSecond: Math.round(totalRows / (elapsedMs / 1000)),
    },
    `write-amplification insert complete ("${label}" state)`,
  );

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "write-amplification scenario failed");
  process.exit(1);
});
