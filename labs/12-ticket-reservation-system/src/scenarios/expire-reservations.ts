import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";

const log = createLogger("lab12:scenario:expire");

export interface ExpireReservationsResult {
  expiredCount: number;
  expiredSeatIds: number[];
}

/**
 * Worker: reverts every seat whose reservation has expired back to
 * AVAILABLE, in one conditional UPDATE.
 *
 * `WHERE status = 'RESERVED' AND reserved_until < now()` is itself the
 * safety property: this statement is safe to run concurrently with itself
 * (e.g. two overlapping worker ticks, or several worker replicas) and
 * concurrently with a payment completing the very same seat at the same
 * moment (complete-payment.ts's conditional UPDATE), because both are single
 * atomic conditional UPDATEs against the same row. Whichever one Postgres
 * happens to execute second simply finds the row's `status` no longer
 * matches its own WHERE clause and affects zero rows - there is no window
 * where a seat could be double-expired or expired-out-from-under a payment
 * that already completed.
 */
export async function expireReservations(pool: Pool): Promise<ExpireReservationsResult> {
  // `id` is a bigint (int8) column - node-postgres returns int8 as a string
  // by default (to avoid silent precision loss above 2^53), so it has to be
  // converted back to a number explicitly to compare against Drizzle's
  // `mode: "number"` ids elsewhere in this lab.
  const result = await pool.query<{ id: string }>(
    `UPDATE seats
     SET status = 'AVAILABLE', reservation_token = NULL, reserved_by = NULL, reserved_until = NULL
     WHERE status = 'RESERVED' AND reserved_until < now()
     RETURNING id`,
  );
  return { expiredCount: result.rowCount ?? 0, expiredSeatIds: result.rows.map((r) => Number(r.id)) };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }

  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  // Demonstration setup: reserve a seat with reserved_until already in the
  // past, so this run always has at least one real expiry to show, the same
  // way a reservation created 10 minutes ago with a 10-minute hold would look
  // by the time the expiration worker's next tick runs.
  const { rows: seatRows } = await pool.query<{ id: number }>("SELECT id FROM seats ORDER BY id LIMIT 1");
  const demoSeatId = seatRows[0]?.id;
  if (demoSeatId) {
    await pool.query(
      `UPDATE seats
       SET status = 'RESERVED', reservation_token = gen_random_uuid(), reserved_by = 'demo-buyer@example.com',
           reserved_until = now() - interval '5 minutes'
       WHERE id = $1`,
      [demoSeatId],
    );
    log.info({ demoSeatId }, "set up a demo seat with reserved_until already in the past");
  }

  const before = await pool.query<{ count: string }>(
    "SELECT count(*) FROM seats WHERE status = 'RESERVED' AND reserved_until < now()",
  );
  log.info({ expiredButNotYetReverted: Number(before.rows[0]!.count) }, "before running the expiration worker");

  const result = await expireReservations(pool);

  log.info(
    { expiredCount: result.expiredCount, expiredSeatIds: result.expiredSeatIds },
    result.expiredCount > 0
      ? "expiration worker reverted expired reservations back to AVAILABLE"
      : "no expired reservations found to revert",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "expire-reservations scenario failed");
    process.exit(1);
  });
}
