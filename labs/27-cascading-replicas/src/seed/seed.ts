import { Faker, en } from "@faker-js/faker";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase } from "../db/primary-client.js";
import { widgets } from "../db/schema.js";

const log = createLogger("lab27:seed");

type Size = "small" | "medium" | "large";

// `widgets` is a deliberately minimal, scenario-specific table (see
// schema.ts) - not one of SPEC.md section 8.2's five named domains, so no
// generator was added to @labs/data-generators, same reasoning as Lab 24's
// `widgets`/Lab 26's `user_profiles`.
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
 * Writes ONLY to the primary. This is the point of the lab: neither replica
 * is ever written to directly - replica-1 receives these rows via WAL
 * replay of the primary, and replica-2 receives them via WAL replay of
 * replica-1's own re-forwarded stream. Idempotent (delete-then-reinsert),
 * same convention as every other lab's seed script.
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
