import { Faker, en } from "@faker-js/faker";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { widgets } from "../db/schema.js";

const log = createLogger("lab23:seed");

type Size = "small" | "medium" | "large";

const SIZE_PRESETS: Record<Size, number> = {
  small: 20,
  medium: 200,
  large: 2000,
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

/**
 * `widgets` is a deliberately minimal, scenario-specific table (see
 * schema.ts) - this lab is about connection/pooling mechanics, not data
 * modeling, so a local generator here is enough; no reason to add it to
 * `@labs/data-generators`.
 *
 * Idempotent: clears the table and reinserts a fresh, deterministic set of
 * rows every run - runs directly against Postgres, never through PgBouncer
 * (see src/db/migrate.ts for the DDL/pooling caveat; a seed script is the
 * same "one connection, one job" shape and gets no benefit from a pool).
 */
async function main() {
  const { seed, size } = parseArgs();
  const count = SIZE_PRESETS[size];

  await waitForDatabase(pool);

  log.info({ seed, size, count }, "clearing existing rows");
  await db.delete(widgets);

  const faker = new Faker({ locale: en });
  faker.seed(seed);

  const rows = Array.from({ length: count }, () => ({
    name: faker.commerce.productName(),
    value: faker.number.int({ min: 1, max: 10_000 }),
  }));

  await db.insert(widgets).values(rows);

  log.info({ inserted: rows.length }, "seed complete");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
