import { generateCustomers } from "@labs/data-generators";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { customers } from "../db/schema.js";

const log = createLogger("lab29:seed");

type Size = "small" | "medium" | "large";

/**
 * "A few hundred to a few thousand rows is enough" (per this lab's brief) -
 * unlike Lab 04's 1M-row indexing lab, the point here is to make a *batched*
 * backfill meaningfully observable (multiple batches, real batch counts),
 * not to stress-test throughput at scale.
 */
const SIZE_PRESETS: Record<Size, number> = {
  small: 500,
  medium: 2_000,
  large: 5_000,
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

/**
 * Idempotent: clears `customers` and reinserts a fresh, deterministic set
 * every run (SPEC.md 8.1). Every seeded row is deliberately left with
 * `display_name = NULL` - these rows represent the "existing rows written
 * before the dual-write code went live" cohort that
 * src/scenarios/expand-contract-migration.ts's batched backfill exists to
 * fix. Rows written *after* dual-write code is live are inserted by the
 * scenario script itself, not by this seed script.
 */
async function main() {
  const { seed, size } = parseArgs();
  const customerCount = SIZE_PRESETS[size];

  await waitForDatabase(pool);

  log.info({ seed, size, customerCount }, "clearing existing rows");
  await db.delete(customers);

  const generatedCustomers = generateCustomers(customerCount, seed);
  const customerRows = generatedCustomers.map((c) => ({
    publicId: c.publicId,
    fullName: c.fullName,
    email: c.email,
    country: c.country,
  }));

  for (let i = 0; i < customerRows.length; i += BATCH_SIZE) {
    await db.insert(customers).values(customerRows.slice(i, i + BATCH_SIZE));
  }

  log.info({ seed, size, customers: customerRows.length }, "seed complete");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
