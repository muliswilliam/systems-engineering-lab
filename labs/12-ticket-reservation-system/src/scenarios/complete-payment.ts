import "dotenv/config";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { reservedUntilFromNow } from "./support.js";

const log = createLogger("lab12:scenario:payment");

export type CompletePaymentResult =
  | { outcome: "sold"; seatId: number }
  | { outcome: "failed"; seatId: number; reason: string };

/**
 * Transitions RESERVED -> SOLD via a single conditional UPDATE.
 *
 * `WHERE id = $1 AND status = 'RESERVED' AND reservation_token = $2 AND
 * reserved_until > now()` bundles three separate checks that all have to be
 * true AT THE SAME INSTANT the write happens: the seat is still reserved
 * (not already expired/cancelled/sold), the caller holds the exact token
 * issued to whichever reservation attempt won (not a guess, not someone
 * else's), and the hold has not lapsed. Any one of those being false makes
 * `rowCount = 0` - there is no in-between "half completed" state, and no
 * separate read-then-write race here either, for the same reason the
 * reservation's conditional UPDATE has none: the check and the write are one
 * atomic statement.
 *
 * Mechanics for the expired-but-not-yet-reverted case: this UPDATE's own
 * `reserved_until > now()` guard rejects an expired reservation's payment
 * attempt immediately, WITHOUT needing expire-reservations.ts to have run
 * first - the two are independent safety nets for the same invariant
 * ("no payment against a lapsed hold"), not a sequential dependency. In
 * production both exist because a payment provider's webhook can arrive
 * seconds to minutes after the hold's `reserved_until`, and the expiration
 * worker's tick interval must not be trusted to always win that race.
 */
export async function completePayment(
  pool: Pool,
  opts: { seatId: number; reservationToken: string },
): Promise<CompletePaymentResult> {
  const result = await pool.query(
    `UPDATE seats
     SET status = 'SOLD'
     WHERE id = $1 AND status = 'RESERVED' AND reservation_token = $2 AND reserved_until > now()`,
    [opts.seatId, opts.reservationToken],
  );

  if (result.rowCount === 1) {
    return { outcome: "sold", seatId: opts.seatId };
  }
  return {
    outcome: "failed",
    seatId: opts.seatId,
    reason: "seat is not RESERVED with this token and an unexpired hold",
  };
}

async function pickSeatId(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ id: number }>("SELECT id FROM seats ORDER BY id LIMIT 1");
  if (!rows[0]) {
    throw new Error("No seats found - run `pnpm seed` first");
  }
  return rows[0].id;
}

async function reserveSeat(
  pool: Pool,
  seatId: number,
  opts: { buyer: string; holdMinutes: number },
): Promise<string> {
  const reservationToken = randomUUID();
  await pool.query(
    `UPDATE seats
     SET status = 'RESERVED', reservation_token = $1, reserved_by = $2, reserved_until = $3
     WHERE id = $4`,
    [reservationToken, opts.buyer, reservedUntilFromNow(opts.holdMinutes), seatId],
  );
  return reservationToken;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }

  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const seatId = await pickSeatId(pool);

  // --- 1. Happy path: valid token, hold not yet expired. -------------------
  const validToken = await reserveSeat(pool, seatId, { buyer: "alice@example.com", holdMinutes: 10 });
  const happyPath = await completePayment(pool, { seatId, reservationToken: validToken });
  log.info({ ...happyPath }, "happy path: valid, unexpired token");

  // --- 2. Failure path: wrong/stale token. ----------------------------------
  await reserveSeat(pool, seatId, { buyer: "bob@example.com", holdMinutes: 10 });
  const wrongToken = randomUUID();
  const wrongTokenResult = await completePayment(pool, { seatId, reservationToken: wrongToken });
  log.info({ ...wrongTokenResult }, "failure path: wrong/stale reservation token");

  // --- 3. Failure path: expired reservation (reserved_until already past). -
  const expiredToken = randomUUID();
  await pool.query(
    `UPDATE seats
     SET status = 'RESERVED', reservation_token = $1, reserved_by = 'carol@example.com',
         reserved_until = now() - interval '1 minute'
     WHERE id = $2`,
    [expiredToken, seatId],
  );
  const expiredResult = await completePayment(pool, { seatId, reservationToken: expiredToken });
  log.info(
    { ...expiredResult },
    "failure path: reservation expired (reserved_until in the past) - rejected even though expire-reservations.ts has not run yet",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "complete-payment scenario failed");
    process.exit(1);
  });
}
