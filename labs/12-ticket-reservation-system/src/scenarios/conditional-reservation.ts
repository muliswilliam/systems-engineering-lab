import "dotenv/config";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
import { reservedUntilFromNow, type ReservationResult } from "./support.js";

const log = createLogger("lab12:scenario:conditional");

export interface ConditionalReservationOptions {
  seatId: number;
  buyer: string;
  holdMinutes?: number;
}

/**
 * THE FIX (primary): a single, conditional UPDATE.
 *
 * `WHERE id = $1 AND status = 'AVAILABLE'` moves the "is this seat still
 * available?" check INTO the same statement that claims it. Postgres
 * evaluates the WHERE clause and applies the UPDATE atomically per row - two
 * concurrent statements targeting the same row cannot both see `AVAILABLE`
 * as true at the moment they write, because the second one to actually
 * execute its UPDATE (row-locked internally by Postgres for the duration of
 * the statement) re-evaluates the WHERE clause against whatever the first
 * one just committed. Exactly one UPDATE can ever match; every other
 * concurrent attempt gets `rowCount = 0` and must report "seat no longer
 * available," not because it read stale data in application code, but
 * because the database itself refused the write.
 *
 * No `BEGIN`/`COMMIT` and no explicit lock are needed - the single statement
 * IS the atomic unit. This is the "prefer datastore-native guarantees"
 * principle (CLAUDE.md) in its purest form here: the invariant ("at most one
 * RESERVED-by transition per seat") is enforced by the WHERE clause, not by
 * coordinating callers.
 */
export async function attemptConditionalReservation(
  pool: Pool,
  opts: ConditionalReservationOptions,
): Promise<ReservationResult> {
  const reservationToken = randomUUID();
  const result = await pool.query(
    `UPDATE seats
     SET status = 'RESERVED', reservation_token = $1, reserved_by = $2, reserved_until = $3
     WHERE id = $4 AND status = 'AVAILABLE'`,
    [reservationToken, opts.buyer, reservedUntilFromNow(opts.holdMinutes ?? 10), opts.seatId],
  );

  if (result.rowCount === 1) {
    return { outcome: "reserved", seatId: opts.seatId, buyer: opts.buyer, reservationToken };
  }
  return { outcome: "unavailable", seatId: opts.seatId, buyer: opts.buyer };
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

  const pool = createPool({ connectionString: process.env.DATABASE_URL, max: ATTEMPTS + 10 });
  await waitForDatabase(pool);

  const seatId = await pickSeatId(pool);
  await resetSeatToAvailable(pool, seatId);

  log.info({ seatId, attempts: ATTEMPTS }, "starting conditional-write reservation attempts");

  const results = await runConcurrently(ATTEMPTS, (index) =>
    attemptConditionalReservation(pool, { seatId, buyer: `buyer-${index}@example.com` }),
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
    log.error({ err: error }, "conditional reservation scenario failed");
    process.exit(1);
  });
}
