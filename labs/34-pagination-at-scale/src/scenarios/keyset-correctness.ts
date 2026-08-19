import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { cursorFromRow, runKeysetPage } from "./pagination-lib.js";

const log = createLogger("lab34:scenario:keyset-correctness");

const PAGE_SIZE = 20;

/**
 * Shows keyset pagination's REAL, precise guarantee against the SAME two
 * mutations `offset-correctness-bug.ts` used to break OFFSET pagination -
 * and then shows the ONE thing keyset pagination genuinely does NOT
 * guarantee, so this lab does not oversell it as a perfect fix.
 *
 * WARNING: this scenario mutates activity_events. Run `pnpm seed` again
 * afterward if you want a clean baseline for the other scenarios.
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  log.info({ pageSize: PAGE_SIZE }, "--- KEYSET PAGINATION: same mutations, checking whether page 2 duplicates or skips a row ---");

  const page1 = await runKeysetPage(pool, null, PAGE_SIZE);
  const cursor1 = cursorFromRow(page1[page1.length - 1]!);
  const baselinePage2 = await runKeysetPage(pool, cursor1, PAGE_SIZE);
  log.info(
    { cursor: cursor1, baselinePage2FirstPublicId: baselinePage2[0]!.public_id },
    "fetched page 1, captured its cursor (last row's (created_at, id)), fetched baseline page 2",
  );

  // --- Mutation 1: insert a new row BEFORE everything (same as the OFFSET demo) ---
  const { rows: minRows } = await pool.query<{ min: string }>("SELECT min(created_at) AS min FROM activity_events");
  const beforeEverything = new Date(new Date(minRows[0]!.min).getTime() - 60 * 60 * 1000).toISOString();
  const { rows: insertedRows } = await pool.query<{ public_id: string }>(
    `INSERT INTO activity_events (actor_name, action, target_type, target_id, created_at)
     VALUES ('system', 'created', 'incident', '1', $1) RETURNING public_id`,
    [beforeEverything],
  );
  const insertedPublicId = insertedRows[0]!.public_id;

  const page2AfterInsertBeforeEverything = await runKeysetPage(pool, cursor1, PAGE_SIZE);
  const noDuplicateFromInsertBefore =
    page2AfterInsertBeforeEverything.length === baselinePage2.length &&
    page2AfterInsertBeforeEverything.every((r, i) => r.public_id === baselinePage2[i]!.public_id);

  log.warn(
    {
      insertedPublicId,
      insertedCreatedAt: beforeEverything,
      page2Unchanged: noDuplicateFromInsertBefore,
    },
    noDuplicateFromInsertBefore
      ? "NO DUPLICATE: inserting a row before the cursor cannot affect `WHERE (created_at, id) > cursor` - the new row's tuple sorts BELOW the cursor, so the condition excludes it regardless of how the table's row POSITIONS shifted. Position is irrelevant to keyset pagination; only the tuple VALUE relative to the cursor matters."
      : "unexpected: page 2 changed after inserting a row before the cursor - investigate",
  );

  await pool.query("DELETE FROM activity_events WHERE public_id = $1", [insertedPublicId]);

  // --- Mutation 2: delete a row already delivered inside page 1 (not the cursor row) ---
  const rowToDelete = page1[5]!;
  await pool.query("DELETE FROM activity_events WHERE id = $1", [rowToDelete.id]);

  const page2AfterDeleteInsidePage1 = await runKeysetPage(pool, cursor1, PAGE_SIZE);
  const noSkipFromDeleteInPage1 =
    page2AfterDeleteInsidePage1.length === baselinePage2.length &&
    page2AfterDeleteInsidePage1.every((r, i) => r.public_id === baselinePage2[i]!.public_id);

  log.warn(
    {
      deletedPublicId: rowToDelete.public_id,
      page2Unchanged: noSkipFromDeleteInPage1,
    },
    noSkipFromDeleteInPage1
      ? "NO SKIP: deleting an already-delivered row from page 1 has ZERO effect on page 2 - the cursor row itself still exists, and the WHERE clause never re-examines anything before it"
      : "unexpected: page 2 changed after deleting a row from page 1 - investigate",
  );

  // --- The honest limitation: a row inserted AFTER the cursor, sorting within page 2's range, DOES appear ---
  const lastRowOfBaselinePage2 = baselinePage2[baselinePage2.length - 1]!;
  const midpointMs = (new Date(cursor1.createdAt).getTime() + new Date(lastRowOfBaselinePage2.created_at).getTime()) / 2;
  const { rows: midInsertRows } = await pool.query<{ public_id: string; created_at: string }>(
    `INSERT INTO activity_events (actor_name, action, target_type, target_id, created_at)
     VALUES ('system', 'created', 'incident', '2', $1) RETURNING public_id, created_at`,
    [new Date(midpointMs).toISOString()],
  );
  const midInsertedPublicId = midInsertRows[0]!.public_id;

  const page2AfterMidInsert = await runKeysetPage(pool, cursor1, PAGE_SIZE);
  const newRowAppeared = page2AfterMidInsert.some((r) => r.public_id === midInsertedPublicId);

  log.warn(
    {
      midInsertedPublicId,
      midInsertedCreatedAt: midInsertRows[0]!.created_at,
      newRowAppeared,
    },
    newRowAppeared
      ? "DOCUMENTED LIMITATION (not a bug): a row inserted AFTER the cursor, whose (created_at, id) sorts WITHIN page 2's remaining range, DOES show up in page 2 - keyset pagination reads the table live on every request, it is not a frozen snapshot. It never skips or duplicates a row that existed in the already-fetched range at cursor-capture time, but it can still surface genuinely new rows that arrive within not-yet-fetched territory. See README Tradeoffs."
      : "unexpected: the mid-range inserted row did not appear in page 2 - investigate",
  );

  await pool.query("DELETE FROM activity_events WHERE public_id = $1", [midInsertedPublicId]);

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "keyset correctness scenario failed");
    process.exit(1);
  });
}
