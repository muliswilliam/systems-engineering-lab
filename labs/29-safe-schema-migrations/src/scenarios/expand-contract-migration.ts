import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";

const log = createLogger("lab29:scenario:expand-contract");

/**
 * PHASE (a) - EXPAND: add the new column, nullable, no default.
 *
 * `IF NOT EXISTS` makes this statement safe to run again even after
 * `pnpm db:migrate` already applied it via drizzle/0001_*.sql (this lab's
 * Drizzle-tracked "safe" migration for exactly this step) - either way, the
 * important, measured fact is the same: adding a nullable column with no
 * default is a pure catalog change. Postgres does not scan or rewrite a
 * single existing row to do it, so it completes in milliseconds regardless
 * of whether the table has 500 rows or 500 million.
 */
export async function applyExpandStep(pool: Pool): Promise<{ durationMs: number }> {
  const start = performance.now();
  await pool.query("ALTER TABLE customers ADD COLUMN IF NOT EXISTS display_name text");
  const durationMs = performance.now() - start;
  log.info({ durationMs }, "phase (a) EXPAND: ALTER TABLE ADD COLUMN display_name text (nullable)");
  return { durationMs };
}

export interface DualWriteCustomerInput {
  fullName: string;
  email: string;
  country: string;
}

/**
 * PHASE (b) - DUAL WRITE: "new, compatible application code" that can read
 * and write BOTH columns. Every write from this point forward keeps
 * full_name and display_name in lock-step, so old code (still reading
 * full_name) and new code (reading display_name) both see correct,
 * up-to-date data for any row written after this code is deployed.
 */
export async function dualWriteInsertCustomer(
  pool: Pool,
  input: DualWriteCustomerInput,
): Promise<{ id: number; publicId: string }> {
  const result = await pool.query<{ id: number; public_id: string }>(
    `INSERT INTO customers (full_name, display_name, email, country)
     VALUES ($1, $1, $2, $3)
     RETURNING id, public_id`,
    [input.fullName, input.email, input.country],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("dual-write insert returned no row");
  }
  return { id: row.id, publicId: row.public_id };
}

export async function dualWriteRenameCustomer(pool: Pool, id: number, fullName: string): Promise<void> {
  await pool.query("UPDATE customers SET full_name = $1, display_name = $1 WHERE id = $2", [
    fullName,
    id,
  ]);
}

export interface BackfillResult {
  batches: number;
  rowsBackfilled: number;
}

/**
 * PHASE (c) - BACKFILL: copy full_name into display_name for every row that
 * predates the dual-write code (display_name IS NULL), in small batches
 * rather than one giant UPDATE (CLAUDE.md: "Large backfills must be batched
 * and resumable"). Because the WHERE clause is always "still NULL", this
 * loop is naturally resumable - if it is interrupted after N batches, simply
 * calling it again picks up exactly where it left off and does not
 * re-touch already-backfilled rows.
 */
export async function backfillDisplayName(pool: Pool, batchSize = 200): Promise<BackfillResult> {
  let batches = 0;
  let rowsBackfilled = 0;

  for (;;) {
    const result = await pool.query(
      `UPDATE customers
       SET display_name = full_name
       WHERE id IN (
         SELECT id FROM customers WHERE display_name IS NULL ORDER BY id LIMIT $1
       )`,
      [batchSize],
    );
    const rowCount = result.rowCount ?? 0;
    if (rowCount === 0) {
      break;
    }
    batches += 1;
    rowsBackfilled += rowCount;
    log.info({ batch: batches, rowsInBatch: rowCount, rowsBackfilled }, "phase (c) BACKFILL: batch complete");
  }

  return { batches, rowsBackfilled };
}

/**
 * PHASE (d) - READ-PATH SWITCH: "new code" reading display_name for a given
 * customer. Called against both a pre-existing (backfilled) row and a
 * freshly dual-written row to prove both cohorts are now correctly readable
 * from the new column.
 */
export async function readDisplayName(pool: Pool, id: number): Promise<string | null> {
  const result = await pool.query<{ display_name: string | null }>(
    "SELECT display_name FROM customers WHERE id = $1",
    [id],
  );
  return result.rows[0]?.display_name ?? null;
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  log.info("--- expand/contract migration: full_name -> display_name, done safely ---");

  const pending = await pool.query<{ count: string }>(
    "SELECT count(*) FROM customers WHERE display_name IS NULL",
  );
  log.info({ pendingRows: pending.rows[0]?.count }, "rows predating this migration (display_name IS NULL)");

  log.info("--- phase (a): expand ---");
  await applyExpandStep(pool);

  log.info("--- phase (b): dual write (simulating newly deployed compatible application code) ---");
  const newCustomer = await dualWriteInsertCustomer(pool, {
    fullName: "Priya Desai",
    email: `priya.desai.${Date.now()}@example.com`,
    country: "India",
  });
  log.info({ newCustomer }, "inserted a new customer through dual-write code - both columns set together");

  log.info("--- phase (c): backfill existing rows written before dual-write code went live ---");
  const backfill = await backfillDisplayName(pool, 200);
  log.info(backfill, "backfill complete");

  log.info("--- phase (d): read-path switch - new code reads display_name for both cohorts ---");
  const existingRow = await pool.query<{ id: number; full_name: string }>(
    "SELECT id, full_name FROM customers WHERE id <> $1 ORDER BY id LIMIT 1",
    [newCustomer.id],
  );
  const existingId = existingRow.rows[0]?.id;
  if (existingId !== undefined) {
    const backfilledDisplayName = await readDisplayName(pool, existingId);
    log.info(
      {
        existingCustomerId: existingId,
        fullName: existingRow.rows[0]?.full_name,
        displayName: backfilledDisplayName,
        correct: backfilledDisplayName === existingRow.rows[0]?.full_name,
      },
      "pre-existing (backfilled) row: display_name matches full_name",
    );
  }

  const dualWrittenDisplayName = await readDisplayName(pool, newCustomer.id);
  log.info(
    {
      newCustomerId: newCustomer.id,
      displayName: dualWrittenDisplayName,
      correct: dualWrittenDisplayName === "Priya Desai",
    },
    "newly dual-written row: display_name is correct without needing any backfill",
  );

  log.info(
    "phase (e), stopping writes to full_name and dropping it, is a LATER migration - see README 'Fix it' - not run here",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "expand-contract scenario failed");
    process.exit(1);
  });
}
