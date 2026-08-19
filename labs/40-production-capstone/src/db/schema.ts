import { sql } from "drizzle-orm";
import {
  pgTable,
  bigint,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  check,
  unique,
  index,
} from "drizzle-orm/pg-core";

/**
 * Capstone domain: a small ticketing/booking platform (SPEC.md Lab 40's own
 * brief). This schema is deliberately the SMALLEST relational model that
 * lets the composed system-level failure scenario (README "Scenario") be
 * real, not a full SPEC.md 8.2 venue/section/inventory/payments model - see
 * README "Architecture" for the scoping rationale, the same "small
 * standalone/independent schema, the lesson is the mechanism" principle
 * Labs 06/11/19/23/etc. each document for their own domains.
 *
 * Four tables compose five mechanisms taught standalone in earlier labs:
 *
 *   seats          -> conditional-write reservation (Lab 11/12)
 *   orders         -> idempotency key + UNIQUE constraint (Lab 15),
 *                     written atomically with outbox_events (Lab 05/16)
 *   outbox_events  -> transactional outbox, claimed by SKIP LOCKED workers
 *                     (Lab 14/16/17)
 *   notification_attempts -> an observability log of every attempt to call
 *                     the simulated notification downstream, wrapped in
 *                     timeout + backoff + circuit breaker (Lab 37)
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
 * State machine (reused fresh from Lab 12, independently defined here):
 *
 *   AVAILABLE -> RESERVED -> SOLD
 *   RESERVED  -> AVAILABLE   (expiration, not implemented in this lab - see
 *                             README "Further experiments")
 *
 * `reserved_by`/`reservation_token`/`reserved_until` are the reservation's
 * own state (no separate `reservations` table, same rationale as Lab 12).
 * `sold_to` is set once, when the seat transitions to SOLD, and is what the
 * naive checkout scenario's bug reads back on a retry (see
 * src/checkout/checkout-naive.ts).
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
    seatNumber: integer("seat_number").notNull(),
    status: text("status").notNull().default("AVAILABLE"),
    reservationToken: uuid("reservation_token"),
    reservedBy: text("reserved_by"),
    reservedUntil: timestamp("reserved_until", { withTimezone: true }),
    soldTo: text("sold_to"),
    priceCents: integer("price_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("seats_event_section_seat_number_key").on(table.eventId, table.section, table.seatNumber),
    check("seats_status_valid", sql`${table.status} in ('AVAILABLE', 'RESERVED', 'SOLD')`),
    check("seats_price_positive", sql`${table.priceCents} > 0`),
  ],
);

/**
 * `idempotency_key` carries the UNIQUE constraint that makes checkout
 * idempotent (Lab 15's mechanism, composed here with Lab 05's transaction
 * boundary and Lab 16's outbox write - see src/checkout/checkout-idempotent.ts
 * for the `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`
 * this column exists to support).
 *
 * `correlation_id` is generated once per logical checkout REQUEST (not per
 * retry attempt, since retries reuse the same idempotency key and the same
 * correlation id) and is threaded through every log line and the outbox
 * event's own payload, so an operator can grep one id across the whole
 * checkout -> outbox -> notification pipeline (Lab 38's tracing concept,
 * composed here rather than re-derived).
 */
export const orders = pgTable(
  "orders",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    idempotencyKey: uuid("idempotency_key").notNull().unique(),
    seatId: bigint("seat_id", { mode: "number" })
      .notNull()
      .references(() => seats.id),
    customerId: text("customer_id").notNull(),
    customerEmail: text("customer_email").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull().default("created"),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("orders_status_valid", sql`${table.status} in ('created', 'failed')`),
    check("orders_amount_positive", sql`${table.amountCents} > 0`),
    index("orders_seat_id_idx").on(table.seatId),
  ],
);

/**
 * Same shape as Lab 17's own `outbox_events`, reimplemented independently
 * here per the independent-labs principle. `payload` carries the
 * `correlationId` alongside the business data so a worker's claim/publish
 * logs can include it without a join back to `orders`.
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "outbox_events_status_valid",
      sql`${table.status} in ('pending', 'processing', 'published', 'failed')`,
    ),
    check("outbox_events_attempts_non_negative", sql`${table.attempts} >= 0`),
    index("outbox_events_status_created_at_idx").on(table.status, table.createdAt),
  ],
);

/**
 * A pure observability log, not a correctness mechanism - nothing reads this
 * table to decide behavior. It exists so the composed scenarios and tests
 * can show an operator's-eye view of exactly what the notification pipeline
 * did during an incident: how many attempts, how many failures, what the
 * circuit breaker's state was at the time, and how long each attempt took.
 */
export const notificationAttempts = pgTable("notification_attempts", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  orderPublicId: uuid("order_public_id").notNull(),
  correlationId: text("correlation_id").notNull(),
  channel: text("channel").notNull().default("email"),
  outcome: text("outcome").notNull(),
  breakerState: text("breaker_state").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
