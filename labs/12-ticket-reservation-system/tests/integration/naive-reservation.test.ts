import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runConcurrently } from "@labs/test-utils";
import { db, pool as drizzlePool, waitForDatabase as waitForDb } from "../../src/db/client.js";
import { seats } from "../../src/db/schema.js";
import { attemptNaiveReservation } from "../../src/scenarios/naive-reservation.js";
import { cleanupEvents, insertEvent, insertSeat } from "./seat-helpers.js";

const ATTEMPTS = 100;
const ARTIFICIAL_DELAY_MS = 50;

// A dedicated pool sized for one real connection per concurrent attempt -
// per CLAUDE.md's "assert invariants, not timing," reproducing the naive
// race reliably (not just narrating it) requires genuinely parallel
// connections, not a small shared pool that would serialize attempts and
// mask the bug. See src/scenarios/naive-reservation.ts's doc comment for why
// the artificial delay is also needed.
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

/**
 * This file proves the naive read-then-write race is real, not just narrated
 * in the README - per CLAUDE.md's "show failure before the fix," and per
 * SPEC.md section 11, assert on the outcome invariant across many concurrent
 * attempts rather than on execution order.
 */
describe("naive reservation (read-then-write, no transaction, no conditional WHERE)", () => {
  it(`is NOT exactly one success out of ${ATTEMPTS} concurrent attempts for the same seat - the race is real`, async () => {
    const event = await insertEvent("Naive Race Event");
    eventIdsToClean.push(event.id);
    const seat = await insertSeat({ eventId: event.id, status: "AVAILABLE" });

    const results = await runConcurrently(ATTEMPTS, (index) =>
      attemptNaiveReservation(racePool, {
        seatId: seat.id,
        buyer: `buyer-${index}@example.com`,
        artificialDelayMs: ARTIFICIAL_DELAY_MS,
      }),
    );

    const believedReserved = results.filter(
      (r) => r.status === "fulfilled" && r.value.outcome === "reserved",
    ).length;

    // The bug, as an assertion: more than one concurrent caller believed it
    // had exclusively reserved the same seat. This is the opposite of the
    // invariant the conditional-write and row-lock scenarios prove holds.
    expect(believedReserved).toBeGreaterThan(1);

    // The seat itself still only has ONE final status in the database - the
    // corruption is that many buyers believe they hold it, not that the row
    // is somehow in two states at once.
    const [finalSeat] = await db.select().from(seats).where(eq(seats.id, seat.id));
    expect(finalSeat!.status).toBe("RESERVED");
  });
});
