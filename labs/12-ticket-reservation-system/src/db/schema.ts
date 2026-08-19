import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, check, unique } from "drizzle-orm/pg-core";

/**
 * Ticketing domain (SPEC.md 8.2), new in this lab. SPEC.md's "Ticketing"
 * entity list for the whole curriculum is aspirational (events, venues,
 * sections, seats, ticket inventory, reservations, orders, payments) - this
 * lab only needs two tables to teach the reservation race condition and its
 * fixes, so it deliberately does not build a normalized venue/section/
 * ticket-inventory model. `seats` carries its own `section`/`row`/
 * `seat_number` columns directly instead of joining out to a `sections`
 * table; there is no separate `reservations` table because a reservation
 * *is* a seat's own state (`status`/`reservation_token`/`reserved_by`/
 * `reserved_until`) - see README.md "Architecture" for the full rationale.
 */
export const events = pgTable("events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  name: text("name").notNull(),
  venueName: text("venue_name").notNull(),
  eventAt: timestamp("event_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * State machine (SPEC.md Lab 12):
 *
 *   AVAILABLE -> RESERVED -> SOLD
 *   RESERVED  -> AVAILABLE   (expiration or cancellation)
 *
 * `status` is a plain `text` column with a `CHECK` rather than a Postgres
 * `ENUM` type - adding a new state later is a metadata-only `CHECK` swap
 * instead of an `ALTER TYPE`, which matters more once a lab starts caring
 * about zero-downtime migrations (Lab 29). The three scenario mechanisms
 * (naive, conditional-write, row-lock) all read and write this same column;
 * none of them use a separate lock table.
 *
 * `reservation_token`/`reserved_by`/`reserved_until` are only meaningful
 * while `status = 'RESERVED'`; they are cleared (`NULL`) whenever a seat
 * reverts to `AVAILABLE` (expiration/cancellation) and left in place once a
 * seat reaches `SOLD` (the token that completed payment stays as a record of
 * which reservation attempt won).
 */
export const seats = pgTable(
  "seats",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    eventId: bigint("event_id", { mode: "number" })
      .notNull()
      .references(() => events.id),
    section: text("section").notNull(),
    row: text("row").notNull(),
    seatNumber: integer("seat_number").notNull(),
    status: text("status").notNull().default("AVAILABLE"),
    reservationToken: uuid("reservation_token"),
    reservedBy: text("reserved_by"),
    reservedUntil: timestamp("reserved_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("seats_event_section_row_seat_number_key").on(
      table.eventId,
      table.section,
      table.row,
      table.seatNumber,
    ),
    check("seats_status_valid", sql`${table.status} in ('AVAILABLE', 'RESERVED', 'SOLD')`),
  ],
);
