import { Client, type Pool } from "pg";
import { createLogger } from "@labs/logging";
import { seedPageViewsFlushed } from "../seed/seed.js";
import { getTableStats, type TableStats } from "./pg-stats.js";

const log = createLogger("lab31:create-bloat");

export interface BloatResult {
  before: TableStats;
  after: TableStats;
  passes: number;
  rows: number;
  durationMs: number;
}

/**
 * THE MECHANISM THIS LAB EXISTS TO REPRODUCE: repeatedly UPDATE every row of
 * a table with autovacuum disabled for that table.
 *
 * Every `UPDATE` leaves the OLD tuple version behind as a dead, no-longer-
 * visible-to-anyone row version (MVCC - see Lab 06). Normally autovacuum
 * would notice `n_dead_tup` climbing past its threshold and clean those dead
 * tuples up in the background, marking their space reusable. With
 * `autovacuum_enabled = false` set on THIS TABLE ONLY (not instance-wide -
 * every other table in this database still autovacuums normally), nothing
 * ever reclaims that space: each of the `passes` full-table UPDATE passes
 * adds another full copy's worth of dead tuples on top of the live ones,
 * and Postgres has to extend the table's file with new pages to hold them
 * once existing pages run out of free space.
 *
 * Shared by `reproduce-bloat.ts` and `vacuum-vs-full.ts` (2 consumers - the
 * repo's own bar for promoting something out of a single scenario file, per
 * Lab 30's `write-prober.ts` precedent).
 *
 * REAL GOTCHA THIS FUNCTION WORKS AROUND: `pg_stat_user_tables.n_live_tup`/
 * `n_dead_tup` are reported by each backend to PostgreSQL's shared
 * statistics area, but a single backend only flushes its OWN pending report
 * at most once per ~1 second (`PGSTAT_MIN_INTERVAL`) unless it disconnects,
 * which forces an immediate final flush. Running all `passes` UPDATEs back
 * to back on ONE long-lived, rapidly-reused connection left this scenario's
 * own `n_dead_tup` readings stale and even briefly showing `n_live_tup`
 * double the real row count during development of this lab - a real,
 * worth-knowing PostgreSQL observability caveat, not a bug in the counters
 * themselves. Opening and cleanly closing a FRESH connection for each pass
 * (mirroring `write-prober.ts`'s own fresh-connection-per-attempt pattern)
 * forces an immediate, accurate flush after every pass, at the cost of one
 * extra connect/disconnect round trip per pass - negligible next to the
 * pass's own full-table UPDATE cost.
 */
export async function reproduceBloat(
  pool: Pool,
  connectionString: string,
  rows: number,
  passes: number,
  seedValue = 42,
): Promise<BloatResult> {
  await seedPageViewsFlushed(connectionString, rows, seedValue);
  await pool.query("ALTER TABLE page_views SET (autovacuum_enabled = false)");

  const before = await getTableStats(pool, "page_views");
  log.info(
    { rows, passes, relationSizeBytes: before.relationSizeBytes, deadTuples: before.deadTuples },
    "baseline: freshly seeded, autovacuum disabled for page_views",
  );

  const start = performance.now();
  for (let pass = 1; pass <= passes; pass += 1) {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await client.query("UPDATE page_views SET view_count = view_count + 1");
    } finally {
      await client.end();
    }

    if (pass % 5 === 0 || pass === passes) {
      const midway = await getTableStats(pool, "page_views");
      log.info(
        { pass, passes, deadTuples: midway.deadTuples, relationSizeBytes: midway.relationSizeBytes },
        "update pass committed",
      );
    }
  }
  const durationMs = performance.now() - start;

  const after = await getTableStats(pool, "page_views");
  return { before, after, passes, rows, durationMs };
}
