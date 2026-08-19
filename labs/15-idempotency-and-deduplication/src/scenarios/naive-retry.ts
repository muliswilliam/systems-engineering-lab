import "dotenv/config";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { countPaymentsFor, scenarioPayee } from "./payment-utils.js";

const log = createLogger("lab15:scenario:naive");

export interface NaivePaymentAttempt {
  idempotencyKey: string | null;
  amountCents: number;
  payee: string;
}

export interface NaivePaymentResult {
  // See payment-utils.ts's `PaymentRow.id` comment: bigint columns come back
  // from raw `pg` queries as strings.
  id: string;
  publicId: string;
}

/**
 * THE NAIVE (BROKEN) PAYMENT INSERT.
 *
 * A plain INSERT - no `ON CONFLICT`, no check-before-insert, no idea that
 * "processing a payment" might ever be asked to happen twice for the same
 * logical request. This is what a payment endpoint looks like before anyone
 * has thought about retries: every call is a brand-new charge.
 *
 * The scenario this models: a client POSTs a charge request. The server
 * processes it - this INSERT commits - but the HTTP response is lost on the
 * way back (the connection resets, the client's request times out even
 * though the server finished). The client's retry logic, reasonably, resends
 * the exact same logical request. Nothing on the server ties the retry to
 * the original call, so it is processed as if it were new.
 */
export async function performNaivePaymentAttempt(
  pool: Pool,
  attempt: NaivePaymentAttempt,
): Promise<NaivePaymentResult> {
  const result = await pool.query<{ id: string; public_id: string }>(
    `INSERT INTO payments (idempotency_key, amount_cents, payee, status)
     VALUES ($1, $2, $3, 'completed')
     RETURNING id, public_id`,
    [attempt.idempotencyKey, attempt.amountCents, attempt.payee],
  );
  return { id: result.rows[0]!.id, publicId: result.rows[0]!.public_id };
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 20 });
  await waitForDatabase(pool);

  const amountCents = 4_999; // $49.99

  // --- 1. No idempotency key at all, retried sequentially. -----------------
  log.info("--- 1. naive retry, NO idempotency key, sequential ---");
  const payeeNoKey = scenarioPayee("Naive No-Key Merchant");
  const first = await performNaivePaymentAttempt(pool, {
    idempotencyKey: null,
    amountCents,
    payee: payeeNoKey,
  });
  log.info({ payment: first }, "first attempt processed - response about to be 'lost'");
  // The response never reaches the client. Its retry logic resends the exact
  // same logical request. Nothing on the server can tell this apart from a
  // new charge.
  const retry = await performNaivePaymentAttempt(pool, {
    idempotencyKey: null,
    amountCents,
    payee: payeeNoKey,
  });
  const rowCountNoKey = await countPaymentsFor(pool, payeeNoKey, amountCents);
  log.warn(
    { firstId: first.id, retryId: retry.id, rowCount: rowCountNoKey },
    rowCountNoKey > 1
      ? "DOUBLE CHARGE: one logical payment now has more than one row"
      : "unexpected: only one row exists",
  );

  // --- 2. A fresh idempotency key generated PER ATTEMPT - a realistic client
  // bug (the retry path calls randomUUID() again instead of reusing the key
  // generated for the original attempt) - fired concurrently, not
  // sequentially, to prove there is no protection even under a race. --------
  log.info("--- 2. naive retry, FRESH idempotency key per attempt, 10-way concurrent ---");
  const payeeFreshKey = scenarioPayee("Naive Fresh-Key Merchant");
  const CONCURRENT_RETRIES = 10;
  const results = await Promise.all(
    Array.from({ length: CONCURRENT_RETRIES }, () =>
      performNaivePaymentAttempt(pool, {
        idempotencyKey: randomUUID(), // bug: should be generated ONCE, before the first attempt
        amountCents,
        payee: payeeFreshKey,
      }),
    ),
  );
  const rowCountFreshKey = await countPaymentsFor(pool, payeeFreshKey, amountCents);
  log.warn(
    { attempts: CONCURRENT_RETRIES, rowCount: rowCountFreshKey, ids: results.map((r) => r.id) },
    rowCountFreshKey === CONCURRENT_RETRIES
      ? "NO PROTECTION: every concurrent retry inserted its own row - a UNIQUE constraint on idempotency_key exists but never fires, because every key really is different"
      : "unexpected: fewer rows than attempts",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "naive scenario failed");
    process.exit(1);
  });
}
