import { afterAll, beforeAll, it, expect } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { reproduceBloat } from "../../src/scenarios/create-bloat.js";
import { getTableStats, explainSeqScanCount } from "../../src/scenarios/pg-stats.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
}
const connectionString = process.env.DATABASE_URL;

// Small enough to keep the test suite fast, large enough that dead-tuple
// counts and physical size deltas are unambiguous, real measurements rather
// than noise.
const ROWS = 3_000;
const PASSES = 6;

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.query("DROP TABLE IF EXISTS page_views_fresh");
  await pool.query(
    "ALTER TABLE page_views RESET (autovacuum_enabled, autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold)",
  );
  await pool.end();
});

it(
  "repeated UPDATEs with autovacuum disabled leave real, measurable dead tuples and physical growth, while the live row count itself never changes",
  async () => {
    const result = await reproduceBloat(pool, connectionString, ROWS, PASSES);

    expect(result.before.deadTuples).toBe(0);
    expect(result.before.liveTuples).toBe(ROWS);

    // Every UPDATE pass leaves one dead tuple per row that autovacuum (now
    // disabled for this table) would otherwise have reclaimed - after
    // `PASSES` full-table passes, dead tuples should be close to
    // ROWS * PASSES, not some small fraction of it.
    expect(result.after.deadTuples).toBeGreaterThan(ROWS * (PASSES - 1));
    // UPDATE never creates or destroys rows - the live row count is
    // invariant across every pass.
    expect(result.after.liveTuples).toBe(ROWS);
    // Real, physical growth: the table should be several times its
    // original size, not just "a bit bigger."
    expect(result.after.relationSizeBytes).toBeGreaterThan(result.before.relationSizeBytes * 3);
  },
  30_000,
);

it(
  "a plain sequential scan for the SAME live row count reads measurably more buffers on the bloated table than on a freshly-written equivalent",
  async () => {
    await reproduceBloat(pool, connectionString, ROWS, PASSES);

    // A dedicated, freshly-opened-then-closed connection - see
    // create-bloat.ts's doc comment on why relying on a long-lived,
    // already-used pool connection can leave this new table's own
    // pg_stat_user_tables row stale immediately after creation.
    const ctasClient = new Client({ connectionString });
    await ctasClient.connect();
    try {
      await ctasClient.query("DROP TABLE IF EXISTS page_views_fresh");
      await ctasClient.query(
        "CREATE TABLE page_views_fresh AS SELECT id, public_id, slug, view_count, updated_at FROM page_views",
      );
    } finally {
      await ctasClient.end();
    }

    const freshStats = await getTableStats(pool, "page_views_fresh");
    expect(freshStats.liveTuples).toBe(ROWS);
    expect(freshStats.deadTuples).toBe(0);

    const bloatedPlan = await explainSeqScanCount(pool, "page_views");
    const freshPlan = await explainSeqScanCount(pool, "page_views_fresh");

    const bloatedBuffers = bloatedPlan.sharedHitBlocks + bloatedPlan.sharedReadBlocks;
    const freshBuffers = freshPlan.sharedHitBlocks + freshPlan.sharedReadBlocks;

    // Both scans return the same single count(*) row for the same live row
    // count - the only real difference is how much physical heap each scan
    // had to touch to compute it.
    expect(bloatedPlan.actualRows).toBe(1);
    expect(freshPlan.actualRows).toBe(1);
    expect(bloatedBuffers).toBeGreaterThan(freshBuffers * 2);
  },
  30_000,
);
