import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runOffsetPage } from "./pagination-lib.js";

const log = createLogger("lab34:scenario:offset-bug");

const PAGE_SIZE = 20;
const PAGE_OFFSET = 100; // page 6 of a 20-row page size

/**
 * Reproduces the two classic OFFSET-pagination correctness bugs against a
 * REAL table, with REAL inserted/deleted rows and REAL row identities
 * (public_id) - not a thought experiment.
 *
 * WARNING: this scenario mutates activity_events (it inserts and deletes
 * real rows) to make the bug observable. Run `pnpm seed` again afterward if
 * you want to restore a clean baseline for the other scenarios.
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  log.info(
    { pageSize: PAGE_SIZE, offset: PAGE_OFFSET },
    "--- OFFSET PAGINATION CORRECTNESS BUG: reproducing a real duplicate row and a real skipped row ---",
  );

  // ------------------------------------------------------------------
  // Bug 1: INSERT before the fetched window -> DUPLICATE row across pages
  // ------------------------------------------------------------------
  const page1 = await runOffsetPage(pool, PAGE_OFFSET, PAGE_SIZE);
  const lastRowOfPage1 = page1[page1.length - 1]!;
  log.info(
    { offset: PAGE_OFFSET, lastRowPublicId: lastRowOfPage1.public_id, lastRowCreatedAt: lastRowOfPage1.created_at },
    `fetched page 1 (rows at positions ${PAGE_OFFSET}-${PAGE_OFFSET + PAGE_SIZE - 1})`,
  );

  const { rows: minRows } = await pool.query<{ min: string }>("SELECT min(created_at) AS min FROM activity_events");
  const beforeEverything = new Date(new Date(minRows[0]!.min).getTime() - 60 * 60 * 1000).toISOString();

  const { rows: insertedRows } = await pool.query<{ public_id: string }>(
    `INSERT INTO activity_events (actor_name, action, target_type, target_id, created_at)
     VALUES ('system', 'created', 'incident', '1', $1)
     RETURNING public_id`,
    [beforeEverything],
  );
  const insertedPublicId = insertedRows[0]!.public_id;
  log.warn(
    { insertedPublicId, createdAt: beforeEverything },
    "a NEW event was inserted with a created_at BEFORE every existing row - in a real feed this is exactly what happens when a backfill job, a clock-skewed writer, or simply a slightly-delayed write lands - this pushes every existing row's position down by exactly one",
  );

  const nextOffset = PAGE_OFFSET + PAGE_SIZE;
  const page2 = await runOffsetPage(pool, nextOffset, PAGE_SIZE);
  const firstRowOfPage2 = page2[0]!;

  const duplicateDetected = firstRowOfPage2.public_id === lastRowOfPage1.public_id;
  log.warn(
    {
      requestedOffset: nextOffset,
      page2FirstRowPublicId: firstRowOfPage2.public_id,
      page1LastRowPublicId: lastRowOfPage1.public_id,
      duplicateDetected,
    },
    duplicateDetected
      ? "BUG REPRODUCED: page 2 (same OFFSET the client would naively request next) starts with the SAME row that was already the LAST row of page 1 - a real, verified duplicate delivered to the client"
      : "duplicate not detected (unexpected - investigate)",
  );

  // Clean up the inserted row so it doesn't skew the skip-bug demo below.
  await pool.query("DELETE FROM activity_events WHERE public_id = $1", [insertedPublicId]);

  // ------------------------------------------------------------------
  // Bug 2: DELETE within the already-fetched window -> SKIPPED row
  // ------------------------------------------------------------------
  const baselinePage1 = await runOffsetPage(pool, PAGE_OFFSET, PAGE_SIZE);
  const victimRow = (await runOffsetPage(pool, nextOffset, 1))[0]!;
  log.info(
    { offset: nextOffset, victimPublicId: victimRow.public_id },
    `before any mutation, the row that WOULD be the first row of page 2 (position ${nextOffset}) is known`,
  );

  const rowToDelete = baselinePage1[5]!; // a row already delivered inside page 1
  await pool.query("DELETE FROM activity_events WHERE id = $1", [rowToDelete.id]);
  log.warn(
    { deletedPublicId: rowToDelete.public_id, deletedPosition: PAGE_OFFSET + 5 },
    "a row INSIDE the already-delivered page 1 window was deleted - in a real feed this is exactly what happens when a user deletes a post/comment, or a moderation action removes content, while another user is mid-scroll. This pulls every subsequent row's position up by exactly one.",
  );

  const page2AfterDelete = await runOffsetPage(pool, nextOffset, PAGE_SIZE);
  const victimStillMissing =
    !baselinePage1.some((r) => r.public_id === victimRow.public_id) &&
    !page2AfterDelete.some((r) => r.public_id === victimRow.public_id);

  log.warn(
    {
      victimPublicId: victimRow.public_id,
      presentInPage1: baselinePage1.some((r) => r.public_id === victimRow.public_id),
      presentInPage2AfterDelete: page2AfterDelete.some((r) => r.public_id === victimRow.public_id),
      skipDetected: victimStillMissing,
    },
    victimStillMissing
      ? "BUG REPRODUCED: the row that would have been the first row of page 2 was NEVER delivered to the client - not in page 1 (fetched before the delete), not in page 2 (fetched after the delete, at the same OFFSET) - a real, verified skipped row"
      : "skip not detected (unexpected - investigate)",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "offset correctness bug scenario failed");
    process.exit(1);
  });
}
