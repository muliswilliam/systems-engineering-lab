import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { metrics } from "../lib/metrics.js";

const log = createLogger("lab40:checkout:idempotent");

export interface IdempotentCheckoutInput {
  seatId: number;
  customerId: string;
  customerEmail: string;
  amountCents: number;
  reservationToken: string;
  /** Generated ONCE by the caller before the first attempt, reused on every retry - see README "Fix it". */
  idempotencyKey: string;
  correlationId: string;
}

export type IdempotentCheckoutResult =
  | { outcome: "created"; orderId: number; orderPublicId: string; wasNewlyInserted: true }
  | { outcome: "duplicate"; orderId: number; orderPublicId: string; wasNewlyInserted: false }
  | { outcome: "rejected"; reason: string };

/**
 * THE FIX (part 1 of 2 - part 2 is the outbox worker's circuit breaker).
 *
 * Composes THREE mechanisms in one transaction, in the order CLAUDE.md's
 * "Transactional Outbox" section prescribes (`BEGIN / write business state /
 * write outbox event / COMMIT`), with idempotency as the outermost gate:
 *
 *   1. Idempotency (Lab 15): `INSERT ... ON CONFLICT (idempotency_key) DO
 *      NOTHING RETURNING *`. A genuinely new logical checkout inserts and
 *      gets its row back; a RETRY of an already-processed checkout (same
 *      key) gets zero rows back here, and this function does no further
 *      work at all for it - no second seat transition, no second outbox
 *      event. Concurrent callers with the SAME key are serialized by
 *      Postgres's own unique index, not by application locking (CLAUDE.md
 *      "prefer datastore-native guarantees").
 *
 *   2. Conditional write (Lab 11/12): the seat transition is STILL guarded
 *      by `WHERE status = 'RESERVED' AND reserved_by = $ AND
 *      reservation_token = $ AND reserved_until > now()` - idempotency alone
 *      would stop duplicate ORDERS but says nothing about whether the
 *      underlying reservation is still valid. If the reservation lapsed
 *      between the first attempt and a legitimate new request reusing that
 *      seat, this UPDATE's `rowCount = 0` triggers a rollback of the whole
 *      transaction, including the just-inserted order row - nothing partial
 *      is left behind.
 *
 *   3. Transactional outbox (Lab 05/16): the order write and the outbox
 *      write commit together or not at all - there is no window where an
 *      order exists with no corresponding `OrderConfirmed` event, and no
 *      window where an event exists for an order that was rolled back.
 */
export async function checkoutIdempotent(
  pool: Pool,
  input: IdempotentCheckoutInput,
): Promise<IdempotentCheckoutResult> {
  const log2 = log.child({ correlationId: input.correlationId, seatId: input.seatId });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const insertResult = await client.query<{ id: number; public_id: string }>(
      `INSERT INTO orders (idempotency_key, seat_id, customer_id, customer_email, amount_cents, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, public_id`,
      [
        input.idempotencyKey,
        input.seatId,
        input.customerId,
        input.customerEmail,
        input.amountCents,
        input.correlationId,
      ],
    );

    if (!insertResult.rows[0]) {
      // A retry of an already-processed request - nothing to roll back (the
      // conflicting INSERT was suppressed, not applied). The fallback SELECT
      // reuses the SAME already-checked-out `client`, not a second
      // `pool.query()` call: under N-way concurrency, every one of the N
      // concurrent callers reaches this branch at once, and if each asked
      // the pool for a SECOND connection while still holding its first, a
      // pool of size N (or smaller) self-deadlocks - every connection
      // checked out and waiting for one more that can never arrive. This is
      // the exact same class of bug Lab 36's own `bounded-queue.ts` ran into
      // (see ROADMAP.md's Lab 36 implementation note) and it is real: an
      // earlier version of this function called `pool.query()` here and hung
      // indefinitely under this lab's own 50-concurrent-duplicate test.
      const existing = await client.query<{ id: number; public_id: string }>(
        `SELECT id, public_id FROM orders WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      await client.query("COMMIT");
      const row = existing.rows[0];
      if (!row) {
        throw new Error(`idempotency_key ${input.idempotencyKey} conflicted but no row was found`);
      }
      metrics.incrementCounter("capstone_checkout_duplicate_suppressed_total");
      log2.info({ orderId: row.id }, "idempotent checkout: duplicate suppressed, returning original order");
      return { outcome: "duplicate", orderId: row.id, orderPublicId: row.public_id, wasNewlyInserted: false };
    }

    const order = insertResult.rows[0];

    const seatUpdate = await client.query(
      `UPDATE seats
       SET status = 'SOLD', sold_to = $1
       WHERE id = $2 AND status = 'RESERVED' AND reserved_by = $1
         AND reservation_token = $3 AND reserved_until > now()`,
      [input.customerId, input.seatId, input.reservationToken],
    );

    if (seatUpdate.rowCount !== 1) {
      await client.query("ROLLBACK");
      metrics.incrementCounter("capstone_checkout_rejected_total", { path: "idempotent" });
      return { outcome: "rejected", reason: "reservation is not valid or has expired" };
    }

    await client.query(
      `INSERT INTO outbox_events (event_type, payload, max_attempts)
       VALUES ('OrderConfirmed', $1, 3)`,
      [
        JSON.stringify({
          orderPublicId: order.public_id,
          correlationId: input.correlationId,
          customerEmail: input.customerEmail,
          amountCents: input.amountCents,
        }),
      ],
    );

    await client.query("COMMIT");
    metrics.incrementCounter("capstone_orders_created_total", { path: "idempotent" });
    log2.info({ orderId: order.id }, "idempotent checkout created exactly one order + outbox event");
    return { outcome: "created", orderId: order.id, orderPublicId: order.public_id, wasNewlyInserted: true };
  } catch (error) {
    await client.query("ROLLBACK");
    log2.error({ err: error }, "idempotent checkout failed");
    throw error;
  } finally {
    client.release();
  }
}
