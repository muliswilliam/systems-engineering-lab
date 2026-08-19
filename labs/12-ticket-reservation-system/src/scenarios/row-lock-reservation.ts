import "dotenv/config";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
import { reservedUntilFromNow, type ReservationResult } from "./support.js";

const log = createLogger("lab12:scenario:row-lock");

export interface RowLockReservationOptions {
  seatId: number;
  buyer: string;
  holdMinutes?: number;
}

/**
 * THE FIX (alternative): `SELECT ... FOR UPDATE` inside a transaction.
 *
 * `BEGIN`, then `SELECT status FROM seats WHERE id = $1 FOR UPDATE` acquires
 * a row-level exclusive lock on this specific seat row and holds it until
 * `COMMIT`/`ROLLBACK`. Any other transaction that also tries to
 * `SELECT ... FOR UPDATE` (or plain `UPDATE`) the same row blocks until this
 * one releases the lock - so by the time a second concurrent attempt's
 * `SELECT ... FOR UPDATE` actually returns, it is guaranteed to see whatever
 * the first attempt just committed, not a stale pre-lock value. The
 * application-level `if (status !== 'AVAILABLE')` check is therefore safe
 * here in a way it was NOT safe in naive-reservation.ts, because the lock
 * closes the exact race window the naive version left open.
 *
 * Compare with conditional-reservation.ts: the row lock needs an open
 * transaction for its entire duration (one held connection per in-flight
 * attempt) and every other writer targeting this row queues up behind it,
 * whereas the conditional UPDATE never blocks anyone - it just wins or loses
 * instantly. The row lock's advantage shows up once a reservation needs to
 * touch *multiple* rows/tables consistently (e.g. also decrementing a
 * per-section inventory counter) - see README.md "Tradeoffs".
 */
export async function attemptRowLockReservation(
  pool: Pool,
  opts: RowLockReservationOptions,
): Promise<ReservationResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<{ status: string }>(
      "SELECT status FROM seats WHERE id = $1 FOR UPDATE",
      [opts.seatId],
    );
    const status = rows[0]?.status;

    if (status !== "AVAILABLE") {
      await client.query("ROLLBACK");
      return { outcome: "unavailable", seatId: opts.seatId, buyer: opts.buyer };
    }

    const reservationToken = randomUUID();
    await client.query(
      `UPDATE seats
       SET status = 'RESERVED', reservation_token = $1, reserved_by = $2, reserved_until = $3
       WHERE id = $4`,
      [reservationToken, opts.buyer, reservedUntilFromNow(opts.holdMinutes ?? 10), opts.seatId],
    );

    await client.query("COMMIT");
    return { outcome: "reserved", seatId: opts.seatId, buyer: opts.buyer, reservationToken };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function resetSeatToAvailable(pool: Pool, seatId: number): Promise<void> {
  await pool.query(
    `UPDATE seats
     SET status = 'AVAILABLE', reservation_token = NULL, reserved_by = NULL, reserved_until = NULL
     WHERE id = $1`,
    [seatId],
  );
}

async function pickSeatId(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ id: number }>("SELECT id FROM seats ORDER BY id LIMIT 1");
  if (!rows[0]) {
    throw new Error("No seats found - run `pnpm seed` first");
  }
  return rows[0].id;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }

  const ATTEMPTS = 100;

  // Each attempt holds its own connection open for the lifetime of its
  // transaction (BEGIN ... FOR UPDATE ... COMMIT), so this pool also needs
  // one physical connection per concurrent attempt.
  const pool = createPool({ connectionString: process.env.DATABASE_URL, max: ATTEMPTS + 10 });
  await waitForDatabase(pool);

  const seatId = await pickSeatId(pool);
  await resetSeatToAvailable(pool, seatId);

  log.info({ seatId, attempts: ATTEMPTS }, "starting row-lock reservation attempts");

  const results = await runConcurrently(ATTEMPTS, (index) =>
    attemptRowLockReservation(pool, { seatId, buyer: `buyer-${index}@example.com` }),
  );

  const reserved = results.filter((r) => r.status === "fulfilled" && r.value.outcome === "reserved").length;
  const rejected = countFulfilled(results) - reserved;

  const { rows: finalRows } = await pool.query<{ status: string; reserved_by: string | null }>(
    "SELECT status, reserved_by FROM seats WHERE id = $1",
    [seatId],
  );

  log.info(
    {
      seatId,
      attempts: ATTEMPTS,
      reserved,
      rejected,
      finalStatus: finalRows[0]?.status,
      finalReservedBy: finalRows[0]?.reserved_by,
    },
    reserved === 1
      ? "INVARIANT HELD: exactly one of the concurrent attempts reserved the seat"
      : `unexpected: ${reserved} attempts reserved the seat (expected exactly 1)`,
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "row-lock reservation scenario failed");
    process.exit(1);
  });
}
