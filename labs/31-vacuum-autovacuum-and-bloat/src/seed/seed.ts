import { fileURLToPath } from "node:url";
import { Faker, en } from "@faker-js/faker";
import { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";

const log = createLogger("lab31:seed");

type Size = "small" | "medium" | "large";

/**
 * `small` (5,000 rows) is the default and what `pnpm test` uses - enough
 * rows that repeated full-table UPDATE passes produce a real, measurable
 * dead-tuple count and size delta in well under a second per pass.
 * `medium` (50,000) and `large` (150,000) are for interactive "Break it"/
 * "Fix it" runs where a bigger, more dramatic VACUUM FULL duration is the
 * point (see README "Break it").
 */
const SIZE_PRESETS: Record<Size, number> = {
  small: 5_000,
  medium: 50_000,
  large: 150_000,
};

const INSERT_BATCH_SIZE = 5_000;

/**
 * Deterministic, seeded, batched insert (per CLAUDE.md's data-generation
 * rules) - a single `unnest`-driven multi-row INSERT per batch rather than
 * one round trip per row. Every row starts at `view_count = 0`; this lab's
 * scenarios are what generate the repeated UPDATEs that create bloat, not
 * the seed itself.
 */
export async function seedPageViews(targetPool: Pool, totalRows: number, seedValue = 42): Promise<void> {
  const faker = new Faker({ locale: en });
  faker.seed(seedValue);

  await targetPool.query("TRUNCATE TABLE page_views RESTART IDENTITY");
  // TRUNCATE's own pg_stat_user_tables reset is delivered through the same
  // deferred, per-backend stats-reporting pipeline as ordinary INSERT/UPDATE
  // deltas (see create-bloat.ts's doc comment) - under rapid, repeated
  // reseeding this was observed to occasionally leave stale live/dead tuple
  // counts from a PRIOR dataset layered underneath this seed's own inserts.
  // `pg_stat_reset_single_table_counters` resets this one table's counters
  // SYNCHRONOUSLY, bypassing that pipeline entirely, guaranteeing every
  // fresh seed starts every scenario's "before" measurement from a real,
  // verified zero baseline.
  await targetPool.query("SELECT pg_stat_reset_single_table_counters('page_views'::regclass)");

  let inserted = 0;
  while (inserted < totalRows) {
    const batchSize = Math.min(INSERT_BATCH_SIZE, totalRows - inserted);
    const slugs = new Array<string>(batchSize);
    for (let i = 0; i < batchSize; i += 1) {
      slugs[i] = `/blog/${faker.lorem.slug({ min: 2, max: 4 })}-${inserted + i}`;
    }
    await targetPool.query(
      `INSERT INTO page_views (slug, view_count) SELECT * FROM unnest($1::text[], $2::bigint[])`,
      [slugs, new Array<number>(batchSize).fill(0)],
    );
    inserted += batchSize;
  }
}

/**
 * Seeds via a DEDICATED, single-use `Pool` that is fully ended (all
 * connections closed) before this function returns, rather than the
 * caller's own long-lived connection/pool. This matters for callers (the
 * scenario scripts) that immediately read `pg_stat_user_tables` afterward:
 * TRUNCATE and INSERT's own dead/live tuple counters are only guaranteed
 * flushed to PostgreSQL's shared statistics area once every connection that
 * touched them disconnects (or after its own ~1s self-reporting throttle
 * window passes) - see `create-bloat.ts`'s doc comment for the full
 * explanation of this real PostgreSQL observability gotcha. Ending a
 * dedicated pool forces that flush immediately and deterministically.
 */
export async function seedPageViewsFlushed(connectionString: string, totalRows: number, seedValue = 42): Promise<void> {
  const seedPool = new Pool({ connectionString, max: 1 });
  try {
    await seedPageViews(seedPool, totalRows, seedValue);
  } finally {
    await seedPool.end();
  }
}

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
 * Idempotent (SPEC.md 8.1): TRUNCATE + RESTART IDENTITY, so re-seeding
 * always leaves a clean, zero-bloat, `view_count = 0` dataset behind
 * regardless of how many scenario runs already churned the previous one.
 */
async function main() {
  const { seed, size, rows } = parseArgs();
  const totalRows = rows ?? SIZE_PRESETS[size];

  await waitForDatabase(pool);

  // Every scenario in this lab may have left `autovacuum_enabled = false`
  // (the bloat scenario) or aggressive per-table thresholds (the autovacuum
  // scenario) set on `page_views` from a previous run - reset to the table's
  // ordinary defaults so each fresh seed starts from a known, documented
  // baseline, the same way Lab 30's TRUNCATE resets `loyalty_points`.
  await pool.query(
    `ALTER TABLE page_views RESET (autovacuum_enabled, autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold)`,
  );

  const start = performance.now();
  await seedPageViews(pool, totalRows, seed);
  const durationMs = performance.now() - start;

  log.info(
    { seed, size, totalRows, durationMs: Number(durationMs.toFixed(0)) },
    "seed complete - every row has view_count = 0, autovacuum settings reset to table defaults",
  );
  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "seed failed");
    process.exit(1);
  });
}
