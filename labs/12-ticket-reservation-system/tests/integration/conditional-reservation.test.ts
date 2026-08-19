import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
import { db, pool as drizzlePool, waitForDatabase as waitForDb } from "../../src/db/client.js";
import { seats } from "../../src/db/schema.js";
import { attemptConditionalReservation } from "../../src/scenarios/conditional-reservation.js";
import { cleanupEvents, insertEvent, insertSeat } from "./seat-helpers.js";

const ATTEMPTS = 100;

let racePool: ReturnType<typeof createPool>;
const eventIdsToClean: number[] = [];

beforeAll(async () => {
  await waitForDb(drizzlePool);
  await migrate(db, { migrationsFolder: "drizzle" });

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  racePool = createPool({ connectionString: process.env.DATABASE_URL, max: ATTEMPTS + 10 });
  await waitForDatabase(racePool);
});

afterEach(async () => {
  if (eventIdsToClean.length > 0) {
    await cleanupEvents(eventIdsToClean.splice(0));
  }
});

afterAll(async () => {
  await racePool.end();
  await drizzlePool.end();
});

describe("conditional-write reservation (single UPDATE ... WHERE status = 'AVAILABLE')", () => {
  it(`exactly one of ${ATTEMPTS} concurrent attempts for the same seat succeeds`, async () => {
    const event = await insertEvent("Conditional Race Event");
    eventIdsToClean.push(event.id);
    const seat = await insertSeat({ eventId: event.id, status: "AVAILABLE" });

    const results = await runConcurrently(ATTEMPTS, (index) =>
      attemptConditionalReservation(racePool, { seatId: seat.id, buyer: `buyer-${index}@example.com` }),
    );

    expect(countFulfilled(results)).toBe(ATTEMPTS); // no attempt should throw/reject

    const reserved = results.filter((r) => r.status === "fulfilled" && r.value.outcome === "reserved").length;
    const unavailable = results.filter(
      (r) => r.status === "fulfilled" && r.value.outcome === "unavailable",
    ).length;

    expect(reserved).toBe(1);
    expect(unavailable).toBe(ATTEMPTS - 1);

    const [finalSeat] = await db.select().from(seats).where(eq(seats.id, seat.id));
    expect(finalSeat!.status).toBe("RESERVED");
    expect(finalSeat!.reservedBy).toMatch(/^buyer-\d+@example\.com$/);
  });

  it("a seat that is already RESERVED rejects every attempt (rowCount = 0)", async () => {
    const event = await insertEvent("Conditional Already Reserved Event");
    eventIdsToClean.push(event.id);
    const seat = await insertSeat({
      eventId: event.id,
      status: "RESERVED",
      reservationToken: "11111111-1111-1111-1111-111111111111",
      reservedBy: "existing-buyer@example.com",
      reservedUntil: new Date(Date.now() + 10 * 60_000),
    });

    const result = await attemptConditionalReservation(racePool, {
      seatId: seat.id,
      buyer: "late-buyer@example.com",
    });

    expect(result.outcome).toBe("unavailable");

    const [finalSeat] = await db.select().from(seats).where(eq(seats.id, seat.id));
    expect(finalSeat!.reservedBy).toBe("existing-buyer@example.com");
  });
});
