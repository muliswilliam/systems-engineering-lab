import "dotenv/config";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
import { reservedUntilFromNow, sleep, type ReservationResult } from "./support.js";

const log = createLogger("lab12:scenario:naive");

export interface NaiveReservationOptions {
  seatId: number;
  buyer: string;
  holdMinutes?: number;
  /**
   * Widens the race window between the read and the write, per CLAUDE.md's
   * "Transactions and Concurrency" allowance for "delays only when needed to
   * make the race observable." Without it, a fast local Postgres plus a
   * small number of concurrent Node connections can sometimes serialize
   * enough (connection setup latency, the event loop's own scheduling) that
   * the naive version's race under-reproduces - see README.md "Break it" for
   * the real measurements that justified adding this.
   */
  artificialDelayMs?: number;
}

/**
 * THE NAIVE (BROKEN) RESERVATION.
 *
 * Reads the seat's status, checks it in application code, and only THEN
 * issues a separate UPDATE - with no transaction and no conditional WHERE on
 * the current status. Two concurrent callers can both read `AVAILABLE`
 * before either one writes: both believe they won the seat, and both issue
 * an (unconditional) UPDATE that succeeds. The last UPDATE to run wins in the
 * database, but every caller whose read passed the application-level check
 * already told its "buyer" they got the seat - that is the double-booking
 * bug, and it is invisible to `rowCount` because this UPDATE's WHERE clause
 * only ever matches on `id`, which always exists.
 *
 * Each attempt gets its OWN connection (`pool.connect()`), held for the
 * duration of the read-delay-write sequence - per CLAUDE.md's "ORM plus SQL"
 * principle this is raw `pg`, not Drizzle, because the whole point is to
 * make the missing transaction/conditional-WHERE visible.
 */
export async function attemptNaiveReservation(
  pool: Pool,
  opts: NaiveReservationOptions,
): Promise<ReservationResult> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ status: string }>("SELECT status FROM seats WHERE id = $1", [
      opts.seatId,
    ]);
    const status = rows[0]?.status;

    if (opts.artificialDelayMs) {
      await sleep(opts.artificialDelayMs);
    }

    if (status !== "AVAILABLE") {
      return { outcome: "unavailable", seatId: opts.seatId, buyer: opts.buyer };
    }

    // Statement 2: a completely separate, unconditional UPDATE. Nothing here
    // re-checks that the seat is STILL AVAILABLE - the application already
    // "decided" based on the read above, which may now be stale.
    const reservationToken = randomUUID();
    await client.query(
      `UPDATE seats
       SET status = 'RESERVED', reservation_token = $1, reserved_by = $2, reserved_until = $3
       WHERE id = $4`,
      [reservationToken, opts.buyer, reservedUntilFromNow(opts.holdMinutes ?? 10), opts.seatId],
    );

    return { outcome: "reserved", seatId: opts.seatId, buyer: opts.buyer, reservationToken };
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
  const ARTIFICIAL_DELAY_MS = 50;

  // One physical connection per concurrent attempt is the point of this
  // demo - see NaiveReservationOptions.artificialDelayMs doc comment above.
  const pool = createPool({ connectionString: process.env.DATABASE_URL, max: ATTEMPTS + 10 });
  await waitForDatabase(pool);

  const seatId = await pickSeatId(pool);
  await resetSeatToAvailable(pool, seatId);

  log.info({ seatId, attempts: ATTEMPTS, artificialDelayMs: ARTIFICIAL_DELAY_MS }, "starting naive reservation race");

  const results = await runConcurrently(ATTEMPTS, (index) =>
    attemptNaiveReservation(pool, {
      seatId,
      buyer: `buyer-${index}@example.com`,
      artificialDelayMs: ARTIFICIAL_DELAY_MS,
    }),
  );

  const believedReserved = results.filter(
    (r) => r.status === "fulfilled" && r.value.outcome === "reserved",
  ).length;
  const rejected = countFulfilled(results) - believedReserved;

  const { rows: finalRows } = await pool.query<{ status: string; reserved_by: string | null }>(
    "SELECT status, reserved_by FROM seats WHERE id = $1",
    [seatId],
  );

  log.warn(
    {
      seatId,
      attempts: ATTEMPTS,
      believedReserved,
      rejected,
      finalStatus: finalRows[0]?.status,
      finalReservedBy: finalRows[0]?.reserved_by,
    },
    believedReserved > 1
      ? "RACE CONFIRMED: more than one concurrent attempt believed it reserved the same seat"
      : "unexpected: only one (or zero) attempts believed they reserved the seat - the race did not reproduce this run",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "naive reservation scenario failed");
    process.exit(1);
  });
}
