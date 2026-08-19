import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

/**
 * Conditional-write seat reservation, reused fresh from Lab 12's own
 * `attemptConditionalReservation` (independent copy - see README
 * "Architecture" for why this capstone reuses the CONCEPT, not the code).
 *
 * `WHERE id = $1 AND status = 'AVAILABLE'` puts the "is this still
 * available?" check inside the same statement that claims it - Postgres
 * evaluates and applies the UPDATE atomically per row, so exactly one
 * concurrent attempt can ever win. No transaction/lock needed: the single
 * statement IS the atomic unit (CLAUDE.md's "prefer datastore-native
 * guarantees").
 */
export type ReservationOutcome =
  | { outcome: "reserved"; seatId: number; reservationToken: string }
  | { outcome: "unavailable"; seatId: number };

export async function reserveSeat(
  pool: Pool,
  opts: { seatId: number; customerId: string; holdMinutes?: number },
): Promise<ReservationOutcome> {
  const reservationToken = randomUUID();
  const holdMinutes = opts.holdMinutes ?? 10;
  const result = await pool.query(
    `UPDATE seats
     SET status = 'RESERVED', reservation_token = $1, reserved_by = $2,
         reserved_until = now() + ($3 || ' minutes')::interval
     WHERE id = $4 AND status = 'AVAILABLE'`,
    [reservationToken, opts.customerId, holdMinutes, opts.seatId],
  );

  if (result.rowCount === 1) {
    return { outcome: "reserved", seatId: opts.seatId, reservationToken };
  }
  return { outcome: "unavailable", seatId: opts.seatId };
}

export async function resetSeatToAvailable(pool: Pool, seatId: number): Promise<void> {
  await pool.query(
    `UPDATE seats
     SET status = 'AVAILABLE', reservation_token = NULL, reserved_by = NULL,
         reserved_until = NULL, sold_to = NULL
     WHERE id = $1`,
    [seatId],
  );
}
