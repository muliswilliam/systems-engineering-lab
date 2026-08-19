import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { reserveSeat } from "../../src/seats/reserve-seat.js";
import { checkoutIdempotent } from "../../src/checkout/checkout-idempotent.js";
import { NotificationService } from "../../src/downstream/notification-service.js";
import { createProtectedWorker } from "../../src/outbox/worker-protected.js";
import { newCorrelationId } from "../../src/lib/correlation.js";
import { runConcurrently } from "@labs/test-utils";
import { createTestEventWithSeats, cleanupTestEvent } from "./db-test-helpers.js";

let eventId: number;

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  if (eventId) await cleanupTestEvent(pool, eventId);
  await pool.end();
});

/**
 * THE CROSS-CUTTING INVARIANT this capstone exists to demonstrate: a
 * property that holds only because idempotency, the transaction boundary,
 * the transactional outbox, SKIP LOCKED claiming, and the circuit breaker
 * ALL work correctly together - no single one of them is sufficient on its
 * own (see README "Why the fix works").
 *
 * Under N concurrent duplicate checkout submissions of the SAME
 * idempotency key, while the notification downstream is fully down:
 *
 *   - exactly 1 order is ever created (idempotency + the UNIQUE constraint);
 *   - exactly 1 outbox event is ever created for it (the outbox write
 *     shares the order's own transaction, so there cannot be more outbox
 *     events than orders, or fewer);
 *   - the number of REAL calls made to the struggling downstream is bounded
 *     by the retry/breaker configuration, NOT by how many duplicate HTTP
 *     requests arrived - 50 duplicates and 5 duplicates cost the downstream
 *     the exact same number of calls, because idempotency collapsed them to
 *     one logical unit of work before the outbox layer ever saw more than
 *     one event.
 */
describe("cross-cutting invariant: idempotency + outbox + SKIP LOCKED + circuit breaker composed", () => {
  it("50 concurrent duplicate checkouts against a fully-down downstream still produce exactly 1 order, 1 outbox event, and a bounded number of downstream calls", async () => {
    const fixture = await createTestEventWithSeats(pool, 1);
    eventId = fixture.eventId;
    const seatId = fixture.seats[0]!.id;
    const customerId = "e2e-buyer@example.com";

    const reservation = await reserveSeat(pool, { seatId, customerId });
    if (reservation.outcome !== "reserved") throw new Error("setup failed");

    const DUPLICATE_REQUESTS = 50;
    const idempotencyKey = randomUUID();
    const correlationId = newCorrelationId();

    const results = await runConcurrently(DUPLICATE_REQUESTS, () =>
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
    expect(created).toBe(1);

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

    // Drain the single outbox event against a fully-down downstream.
    const notificationService = new NotificationService({ seed: 3, health: "down" });
    const worker = createProtectedWorker({
      failureThreshold: 3,
      cooldownMs: 10_000,
      timeoutMs: 100,
      maxAttempts: 3,
      baseDelayMs: 5,
      maxDelayMs: 20,
    });
    const stats = await worker.runProtectedWorker(pool, "e2e-worker", notificationService, { maxEmptyPolls: 5 });

    // Exactly ONE logical event existed, so the downstream call count is
    // bounded by the retry configuration alone (maxAttempts=3 per claim,
    // reclaimed up to max_attempts=3 times before terminal failure = at
    // most 9 real calls) - completely independent of DUPLICATE_REQUESTS
    // having been 50. This is the number that would NOT be bounded if
    // idempotency were missing.
    expect(notificationService.totalCallCount).toBeLessThanOrEqual(9);
    expect(notificationService.totalCallCount).toBeGreaterThan(0);
    expect(stats.published).toBe(0); // downstream never recovers in this test
    expect(stats.failed).toBeGreaterThanOrEqual(1);

    const outboxRow = await pool.query<{ status: string }>(
      `SELECT status FROM outbox_events WHERE payload->>'orderPublicId' IN
         (SELECT public_id::text FROM orders WHERE seat_id = $1)`,
      [seatId],
    );
    expect(outboxRow.rows[0]?.status).toBe("failed");
  });
});
