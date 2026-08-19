import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { cursorFromRow, runKeysetPage, type Cursor } from "../../src/scenarios/pagination-lib.js";
import { reseed } from "./test-helpers.js";

const ROWS = 5_000;
const PAGE_SIZE = 20;
const PAGES_TO_WALK = 50; // 50 * 20 = 1,000 rows, a fifth of the table

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await reseed(pool, ROWS);
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe("keyset pagination invariant", () => {
  it("returns every row exactly once, with no duplicates or gaps, across N sequential pages", async () => {
    const seenIds: number[] = [];
    let cursor: Cursor | null = null;

    for (let page = 0; page < PAGES_TO_WALK; page += 1) {
      const rows = await runKeysetPage(pool, cursor, PAGE_SIZE);
      expect(rows).toHaveLength(PAGE_SIZE);
      seenIds.push(...rows.map((r) => r.id));
      cursor = cursorFromRow(rows[rows.length - 1]!);
    }

    // No duplicates: every id appeared exactly once across all fetched pages.
    const uniqueIds = new Set(seenIds);
    expect(uniqueIds.size).toBe(seenIds.length);

    // No gaps: the set of ids collected via keyset pagination matches EXACTLY
    // the first PAGES_TO_WALK * PAGE_SIZE rows of the canonical
    // ORDER BY (created_at, id) ordering, fetched directly.
    const { rows: canonicalRows } = await pool.query<{ id: number }>(
      "SELECT id FROM activity_events ORDER BY created_at, id LIMIT $1",
      [PAGES_TO_WALK * PAGE_SIZE],
    );
    const canonicalIds = canonicalRows.map((r) => r.id);

    expect(seenIds).toEqual(canonicalIds);
  });

  it("the final cursor correctly identifies the boundary - the very next page continues seamlessly", async () => {
    const firstPage = await runKeysetPage(pool, null, PAGE_SIZE);
    const cursor = cursorFromRow(firstPage[firstPage.length - 1]!);
    const secondPage = await runKeysetPage(pool, cursor, PAGE_SIZE);

    const firstIds = new Set(firstPage.map((r) => r.id));
    const secondIds = new Set(secondPage.map((r) => r.id));
    const overlap = [...secondIds].filter((id) => firstIds.has(id));

    expect(overlap).toHaveLength(0);
    expect(secondPage).toHaveLength(PAGE_SIZE);
  });
});
