import { Faker, en } from "@faker-js/faker";
import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";

const log = createLogger("lab30:seed");

type Size = "small" | "medium" | "large";

/**
 * This is the one lab in the curriculum where "small" is not a handful of
 * rows - the whole point is a table large enough that a single giant
 * UPDATE becomes genuinely dangerous, not just theoretically so.
 *
 * - `small` (20,000 rows) is the DEFAULT and what CI/`pnpm test` uses - big
 *   enough to make batching and resumability real (dozens of batches at a
 *   realistic batch size) while still seeding and running in a few seconds.
 * - `medium` (200,000 rows) is a reasonable "see it for yourself, still
 *   fast" size for interactive use.
 * - `large` (1,000,000 rows) is what `README.md`'s "Break it" section uses
 *   to capture the real, measured naive-vs-batched comparison - seeding it
 *   takes well under a minute, but the naive scenario against it takes long
 *   enough that the blocking is unmistakable on a human timescale, not just
 *   in a log timestamp.
 *
 * `--rows=N` overrides the size preset entirely, per CLAUDE.md's "pnpm seed
 * --rows=1000000" convention.
 */
const SIZE_PRESETS: Record<Size, number> = {
  small: 20_000,
  medium: 200_000,
  large: 1_000_000,
};

const STATUS_WEIGHTS: { value: string; weight: number }[] = [
  { value: "paid", weight: 55 },
  { value: "shipped", weight: 25 },
  { value: "pending", weight: 12 },
  { value: "cancelled", weight: 8 },
];

const INSERT_BATCH_SIZE = 5_000;

function parseArgs(): { seed: number; size: Size; rows?: number } {
  const args = process.argv.slice(2);
  const seedArg = args.find((a) => a.startsWith("--seed="));
  const sizeArg = args.find((a) => a.startsWith("--size="));
  const rowsArg = args.find((a) => a.startsWith("--rows="));
  const seed = seedArg ? Number(seedArg.split("=")[1]) : 42;
  const size = (sizeArg ? sizeArg.split("=")[1] : "small") as Size;
  const rows = rowsArg ? Number(rowsArg.split("=")[1]) : undefined;

  if (!(size in SIZE_PRESETS)) {
    throw new Error(`Unknown --size "${size}". Use small, medium, or large.`);
  }
  if (rows !== undefined && (!Number.isFinite(rows) || rows <= 0)) {
    throw new Error(`--rows must be a positive integer, got "${rowsArg}"`);
  }

  return { seed, size, rows };
}

/**
 * Generates and inserts `count` order rows in batches of `INSERT_BATCH_SIZE`
 * using a single `unnest`-driven multi-row INSERT per batch, rather than
 * either (a) materializing a million-row array in memory first, or (b) doing
 * one round trip per row. Per CLAUDE.md/SPEC.md 8.4: "Large generators
 * should batch or stream inserts instead of loading millions of records into
 * memory." Every seeded row is left with `loyalty_points = NULL` (the
 * column's default) - these are the "existing rows written before the
 * backfill" cohort every scenario in this lab exists to fix.
 */
async function seedOrdersBatched(totalRows: number, seed: number): Promise<void> {
  const faker = new Faker({ locale: en });
  faker.seed(seed);

  const statusPool = STATUS_WEIGHTS.flatMap((s) => Array<string>(s.weight).fill(s.value));

  let inserted = 0;
  while (inserted < totalRows) {
    const batchSize = Math.min(INSERT_BATCH_SIZE, totalRows - inserted);

    const emails = new Array<string>(batchSize);
    const amounts = new Array<number>(batchSize);
    const statuses = new Array<string>(batchSize);
    const createdAts = new Array<Date>(batchSize);

    for (let i = 0; i < batchSize; i += 1) {
      emails[i] = faker.internet.email().toLowerCase();
      amounts[i] = faker.number.int({ min: 500, max: 50_000 });
      statuses[i] = faker.helpers.arrayElement(statusPool);
      createdAts[i] = faker.date.past({ years: 2 });
    }

    await pool.query(
      `INSERT INTO orders (customer_email, amount_cents, status, created_at)
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::timestamptz[])`,
      [emails, amounts, statuses, createdAts],
    );

    inserted += batchSize;
    if (inserted % 100_000 === 0 || inserted === totalRows) {
      log.info({ inserted, totalRows }, "seed: batch inserted");
    }
  }
}

/**
 * Idempotent (SPEC.md 8.1): TRUNCATE instead of DELETE, so re-seeding a
 * million-row table is fast and always leaves a clean, fully-NULL
 * `loyalty_points` cohort behind, regardless of how many scenario runs
 * already backfilled the previous dataset. `RESTART IDENTITY` resets `id`
 * back to 1 so this lab's scenario scripts (which pick specific ids, e.g.
 * "the first row") behave the same way on every fresh seed.
 */
async function main() {
  const { seed, size, rows } = parseArgs();
  const totalRows = rows ?? SIZE_PRESETS[size];

  await waitForDatabase(pool);

  log.info({ seed, size, totalRows }, "truncating orders");
  await pool.query("TRUNCATE TABLE orders RESTART IDENTITY");

  const start = performance.now();
  await seedOrdersBatched(totalRows, seed);
  const durationMs = performance.now() - start;

  log.info(
    { seed, size, totalRows, durationMs: Number(durationMs.toFixed(0)) },
    "seed complete - every row has loyalty_points = NULL",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
