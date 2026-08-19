import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { runOffsetPage } from "../../src/scenarios/pagination-lib.js";
import { reseed } from "./test-helpers.js";

const ROWS = 5_000;
const PAGE_SIZE = 20;
const PAGE_OFFSET = 100;

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

describe("OFFSET pagination correctness bugs (real, reproduced against real rows)", () => {
  it("DUPLICATE: inserting a row before the fetched window causes the next page to repeat the previous page's last row", async () => {
    const page1 = await runOffsetPage(pool, PAGE_OFFSET, PAGE_SIZE);
    const lastRowOfPage1 = page1[page1.length - 1]!;

    const { rows: minRows } = await pool.query<{ min: string }>("SELECT min(created_at) AS min FROM activity_events");
    const beforeEverything = new Date(new Date(minRows[0]!.min).getTime() - 60 * 60 * 1000).toISOString();
    await pool.query(
      `INSERT INTO activity_events (actor_name, action, target_type, target_id, created_at)
       VALUES ('system', 'created', 'incident', '1', $1)`,
      [beforeEverything],
    );

    const nextOffset = PAGE_OFFSET + PAGE_SIZE;
    const page2 = await runOffsetPage(pool, nextOffset, PAGE_SIZE);

    // The exact bug: page 2's first row is the SAME row already delivered
    // as page 1's last row.
    expect(page2[0]!.public_id).toBe(lastRowOfPage1.public_id);
  });

  it("SKIP: deleting a row inside the already-delivered page causes the next page's expected first row to never be delivered", async () => {
    const page1 = await runOffsetPage(pool, PAGE_OFFSET, PAGE_SIZE);
    const nextOffset = PAGE_OFFSET + PAGE_SIZE;

    // The row that WOULD be page 2's first row, captured before any mutation.
    const victimRow = (await runOffsetPage(pool, nextOffset, 1))[0]!;

    // Delete a different row already delivered inside page 1.
    const rowToDelete = page1[5]!;
    await pool.query("DELETE FROM activity_events WHERE id = $1", [rowToDelete.id]);

    const page2AfterDelete = await runOffsetPage(pool, nextOffset, PAGE_SIZE);

    const page1Ids = new Set(page1.map((r) => r.public_id));
    const page2Ids = new Set(page2AfterDelete.map((r) => r.public_id));

    expect(page1Ids.has(victimRow.public_id)).toBe(false);
    expect(page2Ids.has(victimRow.public_id)).toBe(false);
  });
});
