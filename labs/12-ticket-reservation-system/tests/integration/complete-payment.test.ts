import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { seats } from "../../src/db/schema.js";
import { completePayment } from "../../src/scenarios/complete-payment.js";
import { cleanupEvents, insertEvent, insertSeat } from "./seat-helpers.js";

const eventIdsToClean: number[] = [];

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterEach(async () => {
  if (eventIdsToClean.length > 0) {
    await cleanupEvents(eventIdsToClean.splice(0));
  }
});

afterAll(async () => {
  await pool.end();
});

describe("complete-payment (conditional UPDATE ... WHERE status = 'RESERVED' AND reservation_token = $2 AND reserved_until > now())", () => {
  it("happy path: valid token, unexpired hold -> RESERVED becomes SOLD", async () => {
    const event = await insertEvent("Payment Happy Path Event");
    eventIdsToClean.push(event.id);
    const token = randomUUID();
    const seat = await insertSeat({
      eventId: event.id,
      status: "RESERVED",
      reservationToken: token,
      reservedBy: "alice@example.com",
      reservedUntil: new Date(Date.now() + 10 * 60_000),
    });

    const result = await completePayment(pool, { seatId: seat.id, reservationToken: token });

    expect(result.outcome).toBe("sold");

    const [finalSeat] = await db.select().from(seats).where(eq(seats.id, seat.id));
    expect(finalSeat!.status).toBe("SOLD");
  });

  it("failure path: wrong/stale token is rejected (rowCount = 0), seat stays RESERVED", async () => {
    const event = await insertEvent("Payment Wrong Token Event");
    eventIdsToClean.push(event.id);
    const seat = await insertSeat({
      eventId: event.id,
      status: "RESERVED",
      reservationToken: randomUUID(),
      reservedBy: "bob@example.com",
      reservedUntil: new Date(Date.now() + 10 * 60_000),
    });

    const result = await completePayment(pool, { seatId: seat.id, reservationToken: randomUUID() });

    expect(result.outcome).toBe("failed");

    const [finalSeat] = await db.select().from(seats).where(eq(seats.id, seat.id));
    expect(finalSeat!.status).toBe("RESERVED");
  });

  it("failure path: expired reservation is rejected even before the expiration worker has run", async () => {
    const event = await insertEvent("Payment Expired Event");
    eventIdsToClean.push(event.id);
    const token = randomUUID();
    const seat = await insertSeat({
      eventId: event.id,
      status: "RESERVED",
      reservationToken: token,
      reservedBy: "carol@example.com",
      reservedUntil: new Date(Date.now() - 60_000), // already expired, worker has not touched it
    });

    const result = await completePayment(pool, { seatId: seat.id, reservationToken: token });

    expect(result.outcome).toBe("failed");

    // Still RESERVED (not reverted to AVAILABLE) - the expiration worker has
    // not run. The payment attempt is rejected by its own reserved_until >
    // now() guard regardless.
    const [finalSeat] = await db.select().from(seats).where(eq(seats.id, seat.id));
    expect(finalSeat!.status).toBe("RESERVED");
  });

  it("failure path: seat already SOLD rejects a second payment attempt with the same token", async () => {
    const event = await insertEvent("Payment Already Sold Event");
    eventIdsToClean.push(event.id);
    const token = randomUUID();
    const seat = await insertSeat({
      eventId: event.id,
      status: "SOLD",
      reservationToken: token,
      reservedBy: "dave@example.com",
      reservedUntil: new Date(Date.now() + 10 * 60_000),
    });

    const result = await completePayment(pool, { seatId: seat.id, reservationToken: token });

    expect(result.outcome).toBe("failed");
  });
});
