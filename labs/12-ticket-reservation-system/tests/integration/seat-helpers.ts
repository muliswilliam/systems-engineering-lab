import { inArray } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { events, seats } from "../../src/db/schema.js";

/**
 * Each test constructs its own scratch event + seat(s) with a known starting
 * status, mirroring Lab 05's account-helpers.ts pattern - concurrency
 * invariant tests need a seat no other test is touching, not a row shared
 * out of a bulk-seeded dataset.
 */
export async function insertEvent(name = "Test Event") {
  const [event] = await db
    .insert(events)
    .values({ name, venueName: "Test Arena", eventAt: new Date("2026-06-01T20:00:00Z") })
    .returning();
  return event!;
}

export interface InsertSeatOptions {
  eventId: number;
  section?: string;
  row?: string;
  seatNumber?: number;
  status?: "AVAILABLE" | "RESERVED" | "SOLD";
  reservationToken?: string;
  reservedBy?: string;
  reservedUntil?: Date;
}

let seatCounter = 0;

export async function insertSeat(opts: InsertSeatOptions) {
  seatCounter += 1;
  const [seat] = await db
    .insert(seats)
    .values({
      eventId: opts.eventId,
      section: opts.section ?? "A",
      row: opts.row ?? String(seatCounter),
      seatNumber: opts.seatNumber ?? seatCounter,
      status: opts.status ?? "AVAILABLE",
      reservationToken: opts.reservationToken,
      reservedBy: opts.reservedBy,
      reservedUntil: opts.reservedUntil,
    })
    .returning();
  return seat!;
}

export async function cleanupEvents(eventIds: number[]): Promise<void> {
  await db.delete(seats).where(inArray(seats.eventId, eventIds));
  await db.delete(events).where(inArray(events.id, eventIds));
}
