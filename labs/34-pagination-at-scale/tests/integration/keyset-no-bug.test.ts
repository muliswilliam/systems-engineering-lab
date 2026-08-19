import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { cursorFromRow, runKeysetPage } from "../../src/scenarios/pagination-lib.js";
import { reseed } from "./test-helpers.js";

const ROWS = 5_000;
const PAGE_SIZE = 20;

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
}, 120_000);

beforeEach(async () => {
  await reseed(pool, ROWS);
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe("keyset pagination correctness under the SAME mutations that break OFFSET", () => {
  it("does not duplicate a row when a new row is inserted before the cursor", async () => {
    const page1 = await runKeysetPage(pool, null, PAGE_SIZE);
    const cursor = cursorFromRow(page1[page1.length - 1]!);
    const baselinePage2 = await runKeysetPage(pool, cursor, PAGE_SIZE);

    const { rows: minRows } = await pool.query<{ min: string }>("SELECT min(created_at) AS min FROM activity_events");
    const beforeEverything = new Date(new Date(minRows[0]!.min).getTime() - 60 * 60 * 1000).toISOString();
    await pool.query(
      `INSERT INTO activity_events (actor_name, action, target_type, target_id, created_at)
       VALUES ('system', 'created', 'incident', '1', $1)`,
      [beforeEverything],
    );

    const page2AfterInsert = await runKeysetPage(pool, cursor, PAGE_SIZE);
    expect(page2AfterInsert.map((r) => r.public_id)).toEqual(baselinePage2.map((r) => r.public_id));
  });

  it("does not skip a row when an already-delivered row (not the cursor row) is deleted", async () => {
    const page1 = await runKeysetPage(pool, null, PAGE_SIZE);
    const cursor = cursorFromRow(page1[page1.length - 1]!);
    const baselinePage2 = await runKeysetPage(pool, cursor, PAGE_SIZE);

    const rowToDelete = page1[5]!;
    await pool.query("DELETE FROM activity_events WHERE id = $1", [rowToDelete.id]);

    const page2AfterDelete = await runKeysetPage(pool, cursor, PAGE_SIZE);
    expect(page2AfterDelete.map((r) => r.public_id)).toEqual(baselinePage2.map((r) => r.public_id));
  });

  it("DOCUMENTED LIMITATION: a row inserted after the cursor, sorting within the next page's range, DOES appear (this is not a bug - keyset reads live state, it is not a frozen snapshot)", async () => {
    const page1 = await runKeysetPage(pool, null, PAGE_SIZE);
    const cursor = cursorFromRow(page1[page1.length - 1]!);
    const baselinePage2 = await runKeysetPage(pool, cursor, PAGE_SIZE);
    const lastRowOfPage2 = baselinePage2[baselinePage2.length - 1]!;

    const midpointMs = (new Date(cursor.createdAt).getTime() + new Date(lastRowOfPage2.created_at).getTime()) / 2;
    const { rows: inserted } = await pool.query<{ public_id: string }>(
      `INSERT INTO activity_events (actor_name, action, target_type, target_id, created_at)
       VALUES ('system', 'created', 'incident', '2', $1) RETURNING public_id`,
      [new Date(midpointMs).toISOString()],
    );

    const page2AfterMidInsert = await runKeysetPage(pool, cursor, PAGE_SIZE);
    expect(page2AfterMidInsert.some((r) => r.public_id === inserted[0]!.public_id)).toBe(true);
  });
});
