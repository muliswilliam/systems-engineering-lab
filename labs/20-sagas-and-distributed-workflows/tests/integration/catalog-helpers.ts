import { db } from "../../src/db/client.js";
import { inventoryItems, inventoryReservations, orders, payments, sagaLog, shipments } from "../../src/db/schema.js";

/**
 * A larger, test-only catalog (independent of `src/seed/seed.ts`'s real
 * catalog, though shaped the same way) - generous quantities so many tests
 * across several files can each reserve small amounts without running out,
 * without needing to hand-tune stock levels per test.
 */
export const TEST_CATALOG = [
  { sku: "TEST-SKU-A", name: "Test Widget A", availableQuantity: 10_000 },
  { sku: "TEST-SKU-B", name: "Test Widget B", availableQuantity: 10_000 },
  { sku: "TEST-SKU-C", name: "Test Widget C", availableQuantity: 10_000 },
];

/** Clears every table (FK-safe order) and reinserts the fixed test catalog -
 * the same idempotent-reseed shape as `src/seed/seed.ts`, kept separate so
 * the test suite never depends on running `pnpm seed` first. */
export async function resetDatabase(): Promise<void> {
  await db.delete(sagaLog);
  await db.delete(shipments);
  await db.delete(payments);
  await db.delete(inventoryReservations);
  await db.delete(orders);
  await db.delete(inventoryItems);
  await db.insert(inventoryItems).values(TEST_CATALOG);
}
