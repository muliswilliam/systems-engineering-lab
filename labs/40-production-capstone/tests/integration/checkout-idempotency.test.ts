import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { reserveSeat } from "../../src/seats/reserve-seat.js";
import { checkoutIdempotent } from "../../src/checkout/checkout-idempotent.js";
import { checkoutNaive } from "../../src/checkout/checkout-naive.js";
import { newCorrelationId } from "../../src/lib/correlation.js";
import { runConcurrently } from "@labs/test-utils";
import { createTestEventWithSeats, cleanupTestEvent } from "./db-test-helpers.js";

let eventId: number;
const eventIds: number[] = [];

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  for (const id of eventIds) await cleanupTestEvent(pool, id);
  await pool.end();
});

describe("checkout idempotency composed with the transactional outbox (Lab 15 + Lab 05/16, reused fresh)", () => {
  it("naive checkout WITHOUT idempotency creates one order per duplicate request (reproduces the bug)", async () => {
    const fixture = await createTestEventWithSeats(pool, 1);
    eventId = fixture.eventId;
    eventIds.push(eventId);
    const seatId = fixture.seats[0]!.id;
    const customerId = "naive-buyer@example.com";

    const reservation = await reserveSeat(pool, { seatId, customerId });
    if (reservation.outcome !== "reserved") throw new Error("setup failed");

    const DUPLICATES = 10;
    const correlationId = newCorrelationId();
    await runConcurrently(DUPLICATES, () =>
      checkoutNaive(pool, {
        seatId,
        customerId,
        customerEmail: customerId,
        amountCents: 5_000,
        reservationToken: reservation.reservationToken,
        correlationId,
      }),
    );

    const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM orders WHERE seat_id = $1", [seatId]);
    // THE BUG: every duplicate request produced its own order row.
    expect(Number(rows[0]?.count)).toBe(DUPLICATES);
  });

  it("idempotent checkout: N concurrent duplicate requests with the SAME idempotency key create exactly 1 order and exactly 1 outbox event", async () => {
    const fixture = await createTestEventWithSeats(pool, 1);
    eventId = fixture.eventId;
    eventIds.push(eventId);
    const seatId = fixture.seats[0]!.id;
    const customerId = "idempotent-buyer@example.com";

    const reservation = await reserveSeat(pool, { seatId, customerId });
    if (reservation.outcome !== "reserved") throw new Error("setup failed");

    const DUPLICATES = 20;
    const idempotencyKey = randomUUID();
    const correlationId = newCorrelationId();

    const results = await runConcurrently(DUPLICATES, () =>
      checkoutIdempotent(pool, {
        seatId,
        customerId,
        customerEmail: customerId,
        amountCents: 5_000,
        reservationToken: reservation.reservationToken,
        idempotencyKey,
        correlationId,
      }),
    );

    const created = results.filter((r) => r.status === "fulfilled" && r.value.outcome === "created").length;
    const duplicates = results.filter((r) => r.status === "fulfilled" && r.value.outcome === "duplicate").length;
    expect(created).toBe(1);
    expect(duplicates).toBe(DUPLICATES - 1);

    const orderCount = await pool.query<{ count: string }>("SELECT count(*) FROM orders WHERE seat_id = $1", [
      seatId,
    ]);
    expect(Number(orderCount.rows[0]?.count)).toBe(1);

    const outboxCount = await pool.query<{ count: string }>(
      `SELECT count(*) FROM outbox_events WHERE payload->>'orderPublicId' IN
         (SELECT public_id::text FROM orders WHERE seat_id = $1)`,
      [seatId],
    );
    expect(Number(outboxCount.rows[0]?.count)).toBe(1);

    // Every one of the 20 concurrent callers received back the SAME order id.
    const orderIds = new Set(
      results
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof checkoutIdempotent>>> => r.status === "fulfilled")
        .map((r) => (r.value as { orderId: number }).orderId),
    );
    expect(orderIds.size).toBe(1);

    const seatRow = await pool.query<{ status: string }>("SELECT status FROM seats WHERE id = $1", [seatId]);
    expect(seatRow.rows[0]?.status).toBe("SOLD");
  });
});
