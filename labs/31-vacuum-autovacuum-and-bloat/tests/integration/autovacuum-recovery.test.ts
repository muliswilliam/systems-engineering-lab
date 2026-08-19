import { afterAll, beforeAll, it, expect } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { seedPageViewsFlushed } from "../../src/seed/seed.js";
import { getTableStats } from "../../src/scenarios/pg-stats.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
}
const connectionString = process.env.DATABASE_URL;

const ROWS = 2_000;

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.query(
    "ALTER TABLE page_views RESET (autovacuum_enabled, autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold)",
  );
  await pool.end();
});

/**
 * PROVES autovacuum genuinely ran, via `pg_stat_user_tables.autovacuum_count`
 * actually advancing and dead tuples actually dropping - not just "enough
 * time passed that it probably did." `docker-compose.yml` sets
 * `autovacuum_naptime=2s` instance-wide specifically so this test (and the
 * interactive `scenario:autovacuum` script) don't need to wait anywhere
 * close to the 60s default launcher wake-up interval.
 */
it(
  "autovacuum, enabled and tuned to react quickly, automatically reclaims dead tuples with no operator intervention",
  async () => {
    await seedPageViewsFlushed(connectionString, ROWS);
    await pool.query(
      `ALTER TABLE page_views SET (
         autovacuum_enabled = true,
         autovacuum_vacuum_scale_factor = 0.0,
         autovacuum_vacuum_threshold = 50
       )`,
    );

    const before = await getTableStats(pool, "page_views");
    expect(before.deadTuples).toBe(0);

    const updateClient = new Client({ connectionString });
    await updateClient.connect();
    try {
      await updateClient.query("UPDATE page_views SET view_count = view_count + 1");
    } finally {
      await updateClient.end();
    }

    const afterUpdate = await getTableStats(pool, "page_views");
    expect(afterUpdate.deadTuples).toBeGreaterThanOrEqual(ROWS);

    const pollIntervalMs = 300;
    const maxWaitMs = 30_000;
    const pollStart = performance.now();
    let triggered = false;
    let finalStats = afterUpdate;

    while (performance.now() - pollStart < maxWaitMs) {
      const stats = await getTableStats(pool, "page_views");
      if (stats.autovacuumCount > before.autovacuumCount) {
        triggered = true;
        finalStats = stats;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    expect(triggered).toBe(true);
    expect(finalStats.lastAutovacuum).not.toBeNull();
    expect(finalStats.deadTuples).toBeLessThan(afterUpdate.deadTuples * 0.1);
  },
  40_000,
);
