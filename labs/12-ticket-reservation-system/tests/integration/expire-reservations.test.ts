import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { seats } from "../../src/db/schema.js";
import { expireReservations } from "../../src/scenarios/expire-reservations.js";
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

describe("expire-reservations worker (conditional UPDATE WHERE status = 'RESERVED' AND reserved_until < now())", () => {
  it("reverts a seat whose reserved_until is in the past back to AVAILABLE, clearing token/buyer/expiry", async () => {
    const event = await insertEvent("Expiry Event");
    eventIdsToClean.push(event.id);
    const seat = await insertSeat({
      eventId: event.id,
      status: "RESERVED",
      reservationToken: "22222222-2222-2222-2222-222222222222",
      reservedBy: "expired-buyer@example.com",
      reservedUntil: new Date(Date.now() - 60_000), // 1 minute in the past
    });

    const result = await expireReservations(pool);

    expect(result.expiredSeatIds).toContain(seat.id);

    const [finalSeat] = await db.select().from(seats).where(eq(seats.id, seat.id));
    expect(finalSeat!.status).toBe("AVAILABLE");
    expect(finalSeat!.reservationToken).toBeNull();
    expect(finalSeat!.reservedBy).toBeNull();
    expect(finalSeat!.reservedUntil).toBeNull();
  });

  it("does NOT touch a RESERVED seat whose hold has not expired yet", async () => {
    const event = await insertEvent("Not Yet Expired Event");
    eventIdsToClean.push(event.id);
    const seat = await insertSeat({
      eventId: event.id,
      status: "RESERVED",
      reservationToken: "33333333-3333-3333-3333-333333333333",
      reservedBy: "current-buyer@example.com",
      reservedUntil: new Date(Date.now() + 10 * 60_000), // 10 minutes from now
    });

    const result = await expireReservations(pool);

    expect(result.expiredSeatIds).not.toContain(seat.id);

    const [finalSeat] = await db.select().from(seats).where(eq(seats.id, seat.id));
    expect(finalSeat!.status).toBe("RESERVED");
    expect(finalSeat!.reservedBy).toBe("current-buyer@example.com");
  });

  it("does not affect AVAILABLE or SOLD seats", async () => {
    const event = await insertEvent("Unrelated Statuses Event");
    eventIdsToClean.push(event.id);
    const availableSeat = await insertSeat({ eventId: event.id, status: "AVAILABLE" });
    const soldSeat = await insertSeat({ eventId: event.id, status: "SOLD" });

    const result = await expireReservations(pool);

    expect(result.expiredSeatIds).not.toContain(availableSeat.id);
    expect(result.expiredSeatIds).not.toContain(soldSeat.id);

    const [finalAvailable] = await db.select().from(seats).where(eq(seats.id, availableSeat.id));
    const [finalSold] = await db.select().from(seats).where(eq(seats.id, soldSeat.id));
    expect(finalAvailable!.status).toBe("AVAILABLE");
    expect(finalSold!.status).toBe("SOLD");
  });
});
