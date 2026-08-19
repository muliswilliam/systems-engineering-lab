import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { reserveSeat } from "../../src/seats/reserve-seat.js";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
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

describe("seat reservation: conditional write under concurrency (Lab 11/12's mechanism, reused fresh)", () => {
  it("exactly one of 100 concurrent reservation attempts succeeds for the same seat", async () => {
    const fixture = await createTestEventWithSeats(pool, 1);
    eventId = fixture.eventId;
    const seatId = fixture.seats[0]!.id;

    const ATTEMPTS = 100;
    const results = await runConcurrently(ATTEMPTS, (index) =>
      reserveSeat(pool, { seatId, customerId: `customer-${index}@example.com` }),
    );

    const reserved = results.filter((r) => r.status === "fulfilled" && r.value.outcome === "reserved").length;
    const unavailable = countFulfilled(results) - reserved;

    expect(reserved).toBe(1);
    expect(unavailable).toBe(ATTEMPTS - 1);

    const { rows } = await pool.query<{ status: string }>("SELECT status FROM seats WHERE id = $1", [seatId]);
    expect(rows[0]?.status).toBe("RESERVED");
  });
});
