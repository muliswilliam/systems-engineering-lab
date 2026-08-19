import "dotenv/config";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import {
  countPaymentsFor,
  getPaymentsByIdempotencyKey,
  scenarioPayee,
  type PaymentRow,
} from "./payment-utils.js";

const log = createLogger("lab15:scenario:idempotent");

export interface IdempotentPaymentAttempt {
  idempotencyKey: string;
  amountCents: number;
  payee: string;
}

export interface IdempotentPaymentResult {
  row: PaymentRow;
  wasNewlyInserted: boolean;
}

/**
 * THE FIX.
 *
 * The client generates ONE idempotency key up front, when it first forms the
 * intent to charge, and reuses that SAME key on every retry of that SAME
 * logical request - see main() below, which generates the key once, outside
 * the retry loop, unlike naive-retry.ts's buggy per-attempt key.
 *
 * Server-side: `idempotency_key` carries a UNIQUE constraint, and the insert
 * uses `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`.
 * Equivalent raw SQL (this function already IS raw SQL, on purpose - see
 * CLAUDE.md's "ORM plus SQL" - since the ON CONFLICT clause and the
 * conflict-aware RETURNING are exactly the kind of Postgres-specific
 * behavior that should not be hidden behind an ORM abstraction):
 *
 *   INSERT INTO payments (idempotency_key, amount_cents, payee, status)
 *   VALUES ($1, $2, $3, 'completed')
 *   ON CONFLICT (idempotency_key) DO NOTHING
 *   RETURNING *;
 *
 *   -- only run if the statement above returned zero rows:
 *   SELECT * FROM payments WHERE idempotency_key = $1;
 *
 * Two things can happen:
 *
 *   - No row with this key exists yet: the INSERT proceeds normally and
 *     RETURNING hands back the new row (`wasNewlyInserted: true`).
 *   - A row with this key already exists (this IS a retry): Postgres detects
 *     the conflict, DO NOTHING suppresses the insert, and RETURNING produces
 *     zero rows. This function then falls back to a SELECT to fetch the
 *     ORIGINAL row and returns THAT - not a fresh, second row
 *     (`wasNewlyInserted: false`).
 *
 * This is the full idempotency contract, not just "don't duplicate the side
 * effect": every caller that retries with the same key gets back the exact
 * same response the first caller would have gotten.
 *
 * Concurrency safety: if two attempts with the same key race, Postgres's
 * unique index resolves the conflict itself - the second INSERT blocks
 * behind the first inserter's transaction, then (once it commits) sees the
 * conflict and takes the DO NOTHING path. By the time this function's SELECT
 * fallback runs, the winning row is guaranteed to be committed and visible.
 * No advisory lock or `SELECT ... FOR UPDATE` is needed here - the UNIQUE
 * constraint IS the concurrency control (CLAUDE.md's "prefer datastore-native
 * guarantees").
 */
export async function performIdempotentPaymentAttempt(
  pool: Pool,
  attempt: IdempotentPaymentAttempt,
): Promise<IdempotentPaymentResult> {
  const insertResult = await pool.query<PaymentRow>(
    `INSERT INTO payments (idempotency_key, amount_cents, payee, status)
     VALUES ($1, $2, $3, 'completed')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [attempt.idempotencyKey, attempt.amountCents, attempt.payee],
  );

  if (insertResult.rows[0]) {
    return { row: insertResult.rows[0], wasNewlyInserted: true };
  }

  const existing = await getPaymentsByIdempotencyKey(pool, attempt.idempotencyKey);
  const row = existing[0];
  if (!row) {
    // Unreachable in practice: DO NOTHING only suppresses the insert when a
    // conflicting row already exists, so it must be visible to this SELECT.
    throw new Error(`idempotency_key ${attempt.idempotencyKey} conflicted but no row was found`);
  }
  return { row, wasNewlyInserted: false };
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 20 });
  await waitForDatabase(pool);

  const amountCents = 4_999; // $49.99

  // --- 1. Sequential retry: the SAME key reused, exactly like a client that
  // stores its idempotency key before the first attempt and resends it. -----
  log.info("--- 1. idempotent retry, SAME key, sequential ---");
  const payeeSeq = scenarioPayee("Idempotent Sequential Merchant");
  const keySeq = randomUUID(); // generated ONCE, before any attempt
  const first = await performIdempotentPaymentAttempt(pool, {
    idempotencyKey: keySeq,
    amountCents,
    payee: payeeSeq,
  });
  log.info(
    { payment: first.row, wasNewlyInserted: first.wasNewlyInserted },
    "first attempt processed - response about to be 'lost'",
  );
  const retry = await performIdempotentPaymentAttempt(pool, {
    idempotencyKey: keySeq,
    amountCents,
    payee: payeeSeq,
  });
  const rowCountSeq = await countPaymentsFor(pool, payeeSeq, amountCents);
  log.info(
    {
      firstId: first.row.id,
      retryId: retry.row.id,
      sameRow: first.row.id === retry.row.id,
      retryWasNewlyInserted: retry.wasNewlyInserted,
      rowCount: rowCountSeq,
    },
    rowCountSeq === 1 && first.row.id === retry.row.id
      ? "NO DUPLICATE: exactly one row exists, and the retry received back the identical row"
      : "unexpected: the fix did not hold",
  );

  // --- 2. Concurrent retry: 10 "simultaneous" callers, SAME key. -----------
  log.info("--- 2. idempotent retry, SAME key, 10-way concurrent ---");
  const payeeConcurrent = scenarioPayee("Idempotent Concurrent Merchant");
  const keyConcurrent = randomUUID();
  const CONCURRENT_RETRIES = 10;
  const results = await Promise.all(
    Array.from({ length: CONCURRENT_RETRIES }, () =>
      performIdempotentPaymentAttempt(pool, {
        idempotencyKey: keyConcurrent,
        amountCents,
        payee: payeeConcurrent,
      }),
    ),
  );
  const rowCountConcurrent = await countPaymentsFor(pool, payeeConcurrent, amountCents);
  const distinctIds = new Set(results.map((r) => r.row.id));
  const distinctPublicIds = new Set(results.map((r) => r.row.public_id));
  const newlyInsertedCount = results.filter((r) => r.wasNewlyInserted).length;
  log.info(
    {
      attempts: CONCURRENT_RETRIES,
      rowCount: rowCountConcurrent,
      distinctRowIds: distinctIds.size,
      distinctPublicIds: distinctPublicIds.size,
      newlyInsertedCount,
    },
    rowCountConcurrent === 1 && distinctIds.size === 1 && newlyInsertedCount === 1
      ? "EXACTLY ONE ROW INSERTED, and all 10 concurrent callers received the identical response"
      : "unexpected: the fix did not hold under concurrency",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "idempotent scenario failed");
    process.exit(1);
  });
}
