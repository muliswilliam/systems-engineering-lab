import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { metrics } from "../lib/metrics.js";

const log = createLogger("lab40:checkout:naive");

export interface NaiveCheckoutInput {
  seatId: number;
  customerId: string;
  customerEmail: string;
  amountCents: number;
  reservationToken: string;
  correlationId: string;
}

export type NaiveCheckoutResult =
  | { outcome: "created"; orderId: number; orderPublicId: string }
  | { outcome: "rejected"; reason: string };

/**
 * THE BUG.
 *
 * This handler represents a realistic, easy-to-write checkout endpoint: it
 * correctly checks that the CALLER owns the seat (either it is still
 * RESERVED to them with the token they were issued, or it was already SOLD
 * to them by an earlier call) before doing anything - so a stranger cannot
 * check out someone else's reservation, and the seat's own conditional-write
 * state machine (src/seats/reserve-seat.ts, Lab 12's mechanism) is still the
 * source of truth for WHO may act on this seat.
 *
 * What it does NOT have is any concept of "have I already processed this
 * exact logical checkout request before?" - there is no client-supplied
 * idempotency key read from the request at all (`randomUUID()` is generated
 * fresh, server-side, on every call, exactly the "each retry generates its
 * own fresh key instead of reusing one" bug Lab 15's own naive scenario
 * documents). So every one of N duplicate retries of the SAME logical
 * checkout - e.g. because the client's HTTP layer resent the request after
 * the first response was lost on the wire, the literal SPEC.md Lab 15
 * motivating scenario - passes the ownership check (the seat IS sold to this
 * customer, by the first call) and unconditionally inserts ANOTHER order row
 * plus ANOTHER outbox event, once per retry.
 *
 * See README "Scenario"/"Break it" for why this compounds badly once the
 * outbox worker on the other end has to notify the customer once PER order.
 */
export async function checkoutNaive(pool: Pool, input: NaiveCheckoutInput): Promise<NaiveCheckoutResult> {
  const log2 = log.child({ correlationId: input.correlationId, seatId: input.seatId });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const seatResult = await client.query<{
      id: number;
      status: string;
      reserved_by: string | null;
      sold_to: string | null;
      reservation_token: string | null;
    }>(`SELECT id, status, reserved_by, sold_to, reservation_token FROM seats WHERE id = $1 FOR UPDATE`, [
      input.seatId,
    ]);
    const seat = seatResult.rows[0];
    if (!seat) {
      await client.query("ROLLBACK");
      return { outcome: "rejected", reason: "seat not found" };
    }

    const heldByMe =
      seat.status === "RESERVED" &&
      seat.reserved_by === input.customerId &&
      seat.reservation_token === input.reservationToken;
    const alreadySoldToMe = seat.status === "SOLD" && seat.sold_to === input.customerId;

    if (!heldByMe && !alreadySoldToMe) {
      await client.query("ROLLBACK");
      metrics.incrementCounter("capstone_checkout_rejected_total", { path: "naive" });
      return { outcome: "rejected", reason: "seat is not held by this customer with a valid token" };
    }

    if (heldByMe) {
      await client.query(`UPDATE seats SET status = 'SOLD', sold_to = $1 WHERE id = $2`, [
        input.customerId,
        input.seatId,
      ]);
    }

    // THE BUG: a fresh key every call means the orders.idempotency_key
    // UNIQUE constraint (schema-level, same column the fixed path uses) can
    // never catch a retry - it only ever sees keys it has not seen before.
    const freshKeyEveryCall = randomUUID();

    const orderResult = await client.query<{ id: number; public_id: string }>(
      `INSERT INTO orders (idempotency_key, seat_id, customer_id, customer_email, amount_cents, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, public_id`,
      [freshKeyEveryCall, input.seatId, input.customerId, input.customerEmail, input.amountCents, input.correlationId],
    );
    const order = orderResult.rows[0]!;

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
    metrics.incrementCounter("capstone_orders_created_total", { path: "naive" });
    log2.info({ orderId: order.id }, "naive checkout created an order (no idempotency guard)");
    return { outcome: "created", orderId: order.id, orderPublicId: order.public_id };
  } catch (error) {
    await client.query("ROLLBACK");
    log2.error({ err: error }, "naive checkout failed");
    throw error;
  } finally {
    client.release();
  }
}
