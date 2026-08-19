import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
import { db, pool as drizzlePool, waitForDatabase as waitForDb } from "../../src/db/client.js";
import { seats } from "../../src/db/schema.js";
import { attemptRowLockReservation } from "../../src/scenarios/row-lock-reservation.js";
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
  // Each attempt holds a transaction (and its connection) open for the
  // lifetime of BEGIN ... FOR UPDATE ... COMMIT, so this pool needs the same
  // one-connection-per-attempt headroom as the conditional-write test.
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

describe("row-lock reservation (BEGIN; SELECT ... FOR UPDATE; UPDATE; COMMIT)", () => {
  it(`exactly one of ${ATTEMPTS} concurrent attempts for the same seat succeeds`, async () => {
    const event = await insertEvent("Row Lock Race Event");
    eventIdsToClean.push(event.id);
    const seat = await insertSeat({ eventId: event.id, status: "AVAILABLE" });

    const results = await runConcurrently(ATTEMPTS, (index) =>
      attemptRowLockReservation(racePool, { seatId: seat.id, buyer: `buyer-${index}@example.com` }),
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

  it("a seat that is already SOLD rejects the attempt without ever reaching the UPDATE", async () => {
    const event = await insertEvent("Row Lock Already Sold Event");
    eventIdsToClean.push(event.id);
    const seat = await insertSeat({ eventId: event.id, status: "SOLD" });

    const result = await attemptRowLockReservation(racePool, { seatId: seat.id, buyer: "late-buyer@example.com" });

    expect(result.outcome).toBe("unavailable");

    const [finalSeat] = await db.select().from(seats).where(eq(seats.id, seat.id));
    expect(finalSeat!.status).toBe("SOLD");
  });
});
