import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { runNaiveRenameIncident } from "../../src/scenarios/naive-rename-breaks-old-code.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

/**
 * This file proves the incident is real, not just narrated in the README -
 * per CLAUDE.md's "show failure before the fix," the naive rename's breakage
 * must actually be observable in a test, with the real Postgres error code.
 */
describe("naive migration: RENAME COLUMN while old application code is still running", () => {
  it("old code succeeds before the rename, then fails with SQLSTATE 42703 the instant it commits", async () => {
    const connectionString = process.env.DATABASE_URL as string;
    const result = await runNaiveRenameIncident(connectionString);

    expect(result.oldCodeValueBeforeRename).toBeTruthy();
    expect(result.oldCodeErrorCode).toBe("42703");
    expect(result.oldCodeErrorMessage).toMatch(/full_name/);
    expect(result.oldCodeErrorMessage).toMatch(/does not exist/);

    // The new column was there the whole time, holding the same value - the
    // only thing missing was application code that knew to read it.
    expect(result.newCodeValueAfterRename).toBe(result.oldCodeValueBeforeRename);
  });

  it("is fully repeatable - the scratch demo table lets the exact same incident reproduce again", async () => {
    const connectionString = process.env.DATABASE_URL as string;
    const result = await runNaiveRenameIncident(connectionString);

    expect(result.oldCodeErrorCode).toBe("42703");
  });

  it("does not touch the real customers table full_name/display_name columns used by the rest of this lab", async () => {
    const connectionString = process.env.DATABASE_URL as string;
    const before = await pool.query<{ count: string }>("SELECT count(*) FROM customers");

    await runNaiveRenameIncident(connectionString);

    const after = await pool.query<{ count: string }>("SELECT count(*) FROM customers");
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'customers'`,
    );
    const columnNames = columns.rows.map((r) => r.column_name);

    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    expect(columnNames).toContain("full_name");
  });
});
