import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { inventoryItems, inventoryReservations, orders, payments, sagaLog, shipments } from "../db/schema.js";

const log = createLogger("lab20:seed");

type Size = "small" | "medium" | "large";

/**
 * Per the brief, this lab seeds a small FIXED inventory catalog rather than
 * a faker-generated product list - there is no reusable "generate N
 * products" concept here, only five specific SKUs the scenarios and tests
 * reference by name. `--size` scales quantity (how much stock exists), not
 * catalog breadth (which SKUs exist) - the catalog itself never changes.
 * No `@faker-js/faker` dependency is needed for this lab as a result (a
 * deliberate, documented deviation from other labs' seed scripts - see
 * README "Architecture").
 */
const CATALOG: Array<{ sku: string; name: string; baseQuantity: number }> = [
  { sku: "SKU-KEYBOARD-001", name: "Mechanical Keyboard", baseQuantity: 200 },
  { sku: "SKU-MOUSE-002", name: "Wireless Mouse", baseQuantity: 150 },
  { sku: "SKU-HUB-003", name: "USB-C Hub", baseQuantity: 180 },
  { sku: "SKU-MONITOR-004", name: "27in Monitor", baseQuantity: 90 },
  { sku: "SKU-STAND-005", name: "Laptop Stand", baseQuantity: 120 },
];

const SIZE_MULTIPLIERS: Record<Size, number> = {
  small: 1,
  medium: 5,
  large: 20,
};

function parseArgs(): { seed: number; size: Size } {
  const args = process.argv.slice(2);
  const seedArg = args.find((a) => a.startsWith("--seed="));
  const sizeArg = args.find((a) => a.startsWith("--size="));
  const seed = seedArg ? Number(seedArg.split("=")[1]) : 42;
  const size = (sizeArg ? sizeArg.split("=")[1] : "small") as Size;

  if (!(size in SIZE_MULTIPLIERS)) {
    throw new Error(`Unknown --size "${size}". Use small, medium, or large.`);
  }

  return { seed, size };
}

/**
 * Idempotent: clears every table (in FK-safe order: saga_log and the leaf
 * tables first, then orders, then inventory_items) and reinserts the fixed
 * catalog at the requested size every run - running this twice with the
 * same flags leaves the database in the same logical state (SPEC.md 8.1).
 * `--seed` is accepted for interface consistency with every other lab's
 * seed script; this lab's catalog has no randomness to seed (see the
 * `CATALOG` comment above), so it is only logged, not used to vary data.
 */
async function main() {
  const { seed, size } = parseArgs();
  const multiplier = SIZE_MULTIPLIERS[size];

  await waitForDatabase(pool);

  log.info({ seed, size }, "clearing existing rows");
  await db.delete(sagaLog);
  await db.delete(shipments);
  await db.delete(payments);
  await db.delete(inventoryReservations);
  await db.delete(orders);
  await db.delete(inventoryItems);

  const inserted = await db
    .insert(inventoryItems)
    .values(
      CATALOG.map((item) => ({
        sku: item.sku,
        name: item.name,
        availableQuantity: item.baseQuantity * multiplier,
      })),
    )
    .returning({ sku: inventoryItems.sku, availableQuantity: inventoryItems.availableQuantity });

  log.info({ seed, size, catalog: inserted }, "seed complete");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
