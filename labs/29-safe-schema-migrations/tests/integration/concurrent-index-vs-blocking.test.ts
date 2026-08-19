import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import {
  raceCreateIndexConcurrently,
  raceCreateIndexPlain,
} from "../../src/scenarios/concurrent-index-vs-blocking.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("DROP INDEX IF EXISTS idx_customers_country_plain");
  await client.query("DROP INDEX IF EXISTS idx_customers_country_concurrent");
  await client.end();
  await pool.end();
});

describe("plain CREATE INDEX vs CREATE INDEX CONCURRENTLY against a held write lock", () => {
  it("a plain CREATE INDEX does not return until the blocking write-holding transaction ends", async () => {
    const idsResult = await pool.query<{ id: number }>("SELECT id FROM customers ORDER BY id LIMIT 1");
    const customerId = idsResult.rows[0]!.id;
    const holdMs = 800;

    const result = await raceCreateIndexPlain(process.env.DATABASE_URL as string, customerId, holdMs);

    // Structural, not a fragile timing ratio: the plain CREATE INDEX cannot
    // have completed meaningfully before the blocking transaction released
    // its ROW EXCLUSIVE lock.
    expect(result.createIndexDurationMs).toBeGreaterThanOrEqual(holdMs - 150);
  });

  it("CREATE INDEX CONCURRENTLY lets an unrelated write against the table succeed while it is still building", async () => {
    const idsResult = await pool.query<{ id: number }>("SELECT id FROM customers ORDER BY id LIMIT 2");
    const [row1, row2] = idsResult.rows;
    const holdMs = 800;

    const result = await raceCreateIndexConcurrently(
      process.env.DATABASE_URL as string,
      row1!.id,
      row2!.id,
      holdMs,
    );

    // The core structural invariant this scenario exists to prove: the
    // unrelated write succeeded well before the held transaction (and the
    // concurrent index build) finished - it was never queued up behind
    // either of them, unlike the plain CREATE INDEX case above.
    expect(result.thirdWriteDurationMs).toBeLessThan(holdMs / 2);
  });
});
