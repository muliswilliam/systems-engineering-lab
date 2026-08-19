import { afterAll, beforeAll, it, expect } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { reproduceBloat } from "../../src/scenarios/create-bloat.js";
import { getTableStats } from "../../src/scenarios/pg-stats.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
}
const connectionString = process.env.DATABASE_URL;

const ROWS = 3_000;
const PASSES = 6;

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

it(
  "plain VACUUM reclaims (marks reusable) dead tuples but does NOT shrink the file on disk",
  async () => {
    const bloat = await reproduceBloat(pool, connectionString, ROWS, PASSES);
    expect(bloat.after.deadTuples).toBeGreaterThan(0);

    await pool.query("VACUUM page_views");
    const afterVacuum = await getTableStats(pool, "page_views");

    // Dead tuples are reclaimed - down close to zero, not just "reduced."
    expect(afterVacuum.deadTuples).toBeLessThan(bloat.after.deadTuples * 0.05);
    // But the file itself did NOT shrink - plain VACUUM marks space
    // reusable for FUTURE writes, it does not return it to the OS. Allow a
    // small tolerance for trailing empty pages VACUUM may truncate.
    expect(afterVacuum.relationSizeBytes).toBeGreaterThan(bloat.after.relationSizeBytes * 0.9);
  },
  30_000,
);

it(
  "VACUUM FULL rewrites the table into a new, genuinely smaller file",
  async () => {
    const bloat = await reproduceBloat(pool, connectionString, ROWS, PASSES);
    await pool.query("VACUUM page_views");
    const beforeFull = await getTableStats(pool, "page_views");
    expect(beforeFull.relationSizeBytes).toBeGreaterThan(bloat.before.relationSizeBytes * 3);

    await pool.query("VACUUM FULL page_views");
    const afterFull = await getTableStats(pool, "page_views");

    // The rewritten file should be close to the size of a table holding
    // only the live rows - dramatically smaller than the bloated file.
    expect(afterFull.relationSizeBytes).toBeLessThan(beforeFull.relationSizeBytes * 0.5);
    expect(afterFull.liveTuples).toBe(ROWS);
    expect(afterFull.deadTuples).toBeLessThan(5);
  },
  30_000,
);
