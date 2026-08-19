import "dotenv/config";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import {
  callPaymentProcessor,
  countPaymentsFor,
  getPaymentsByIdempotencyKey,
  scenarioPayee,
  type PaymentRow,
} from "./payment-utils.js";

const log = createLogger("lab15:scenario:cached-result");

export interface CachedResultAttempt {
  idempotencyKey: string;
  amountCents: number;
  payee: string;
}

export interface CachedResultOutcome {
  row: PaymentRow;
  wasNewlyInserted: boolean;
  /** What THIS specific call computed locally, whether or not it was the one
   * that ended up persisted - kept around so callers/tests can prove the
   * response handed back to a retried caller is NOT what that caller itself
   * just (re)computed. */
  locallyComputed: { confirmationCode: string; processingFeeCents: number };
}

/**
 * THE "CACHED RESULT" HALF OF THE LAB - distinct from plain duplicate
 * suppression.
 *
 * Extends idempotent-insert.ts's INSERT ... ON CONFLICT DO NOTHING RETURNING
 * / SELECT-fallback pattern to a "processing" step that isn't just a bare
 * INSERT: it also calls a (simulated) payment processor that computes a
 * confirmation code and a processing fee. `callPaymentProcessor` runs on
 * EVERY call, including retries - it has no idea whether this is the first
 * attempt or the fifth, and its result is genuinely non-deterministic (see
 * payment-utils.ts). What makes this safe is the exact same mechanism as
 * idempotent-insert.ts: if a row for this key already exists, whatever this
 * call just computed is discarded (never inserted), and the caller is handed
 * back the values that were persisted by the FIRST successful attempt.
 *
 * Why this matters as a SEPARATE lesson from duplicate suppression: a naive
 * idempotency implementation could correctly avoid inserting a second row
 * while still handing the retrying caller the WRONG answer - e.g. by
 * returning the value it just computed locally instead of looking up what
 * was actually persisted. A caller who gets back two different confirmation
 * codes for "the same charge" (one on the original request, a different one
 * on the retry) has no way to know which one is real, even though only one
 * row exists in the database. The full idempotency contract is: same key in,
 * same recorded result out, every time.
 */
export async function performCachedResultPaymentAttempt(
  pool: Pool,
  attempt: CachedResultAttempt,
): Promise<CachedResultOutcome> {
  const locallyComputed = callPaymentProcessor(attempt.amountCents);

  const insertResult = await pool.query<PaymentRow>(
    `INSERT INTO payments (idempotency_key, amount_cents, payee, status, confirmation_code, processing_fee_cents)
     VALUES ($1, $2, $3, 'completed', $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      attempt.idempotencyKey,
      attempt.amountCents,
      attempt.payee,
      locallyComputed.confirmationCode,
      locallyComputed.processingFeeCents,
    ],
  );

  if (insertResult.rows[0]) {
    return { row: insertResult.rows[0], wasNewlyInserted: true, locallyComputed };
  }

  const existing = await getPaymentsByIdempotencyKey(pool, attempt.idempotencyKey);
  const row = existing[0];
  if (!row) {
    throw new Error(`idempotency_key ${attempt.idempotencyKey} conflicted but no row was found`);
  }
  return { row, wasNewlyInserted: false, locallyComputed };
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 20 });
  await waitForDatabase(pool);

  const amountCents = 12_500; // $125.00

  log.info("--- cached result pattern, SAME key, 10-way concurrent ---");
  const payee = scenarioPayee("Cached Result Merchant");
  const idempotencyKey = randomUUID();
  const CONCURRENT_RETRIES = 10;

  const outcomes = await Promise.all(
    Array.from({ length: CONCURRENT_RETRIES }, () =>
      performCachedResultPaymentAttempt(pool, { idempotencyKey, amountCents, payee }),
    ),
  );

  const rowCount = await countPaymentsFor(pool, payee, amountCents);
  const distinctPersistedConfirmationCodes = new Set(outcomes.map((o) => o.row.confirmation_code));
  const distinctPersistedFees = new Set(outcomes.map((o) => o.row.processing_fee_cents));
  const distinctLocallyComputedCodes = new Set(outcomes.map((o) => o.locallyComputed.confirmationCode));
  const newlyInsertedCount = outcomes.filter((o) => o.wasNewlyInserted).length;

  log.info(
    {
      attempts: CONCURRENT_RETRIES,
      rowCount,
      newlyInsertedCount,
      distinctPersistedConfirmationCodes: distinctPersistedConfirmationCodes.size,
      distinctPersistedProcessingFees: distinctPersistedFees.size,
      distinctLocallyComputedConfirmationCodes: distinctLocallyComputedCodes.size,
    },
    rowCount === 1 &&
      distinctPersistedConfirmationCodes.size === 1 &&
      distinctLocallyComputedCodes.size === CONCURRENT_RETRIES
      ? "CACHED RESULT CONFIRMED: all 10 calls independently computed their OWN confirmation code, but all 10 received back the SAME persisted code and fee - 9 of the 10 locally-computed values were correctly discarded"
      : "unexpected: callers received different persisted results for the same idempotency key",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "cached-result scenario failed");
    process.exit(1);
  });
}
