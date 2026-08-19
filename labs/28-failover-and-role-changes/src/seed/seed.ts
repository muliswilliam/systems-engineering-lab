import { Faker, en } from "@faker-js/faker";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase } from "../db/primary-client.js";
import { widgets } from "../db/schema.js";

const log = createLogger("lab28:seed");

type Size = "small" | "medium" | "large";

// `widgets` is a deliberately minimal, scenario-specific table (see
// schema.ts) - same reasoning as Lab 24's `widgets`/Lab 06's
// `counters`/Lab 11's `documents`: no generator was added to
// @labs/data-generators for it.
const SIZE_PRESETS: Record<Size, number> = {
  small: 20,
  medium: 200,
  large: 2_000,
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
 * Writes ONLY to the primary - idempotent via delete-then-reinsert, same
 * convention as every other replication lab in this repository. Running
 * this twice produces the identical row count both times.
 */
async function main() {
  const { seed, size } = parseArgs();
  const rowCount = SIZE_PRESETS[size];

  await waitForDatabase(primaryPool);

  log.info({ seed, size }, "clearing existing rows on primary");
  await primaryDb.delete(widgets);

  const faker = new Faker({ locale: en });
  faker.seed(seed);

  const rows = Array.from({ length: rowCount }, (_, i) => ({
    name: `${faker.commerce.productAdjective()} ${faker.commerce.product()} #${i + 1}`,
    value: faker.number.int({ min: 1, max: 10_000 }),
  }));

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await primaryDb.insert(widgets).values(rows.slice(i, i + BATCH_SIZE));
  }

  log.info({ seed, size, widgets: rows.length }, "seed complete on primary");
  await primaryPool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
