import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, jsonb, check } from "drizzle-orm/pg-core";

/**
 * A fresh, deliberately minimal commerce-adjacent domain - NOT SPEC.md 8.2's
 * full "Commerce" model (customers, products, carts, orders, order_lines,
 * payments, shipments). This lab is about the atomicity of "write the
 * business row and record the intent to publish an event" - a rich
 * relational order model would only add noise around that one mechanism
 * (same rationale as Lab 06's `counters` and Lab 11's `documents`: see those
 * labs' README "Architecture" sections). `customer_name` is a plain string,
 * not a foreign key into a `customers` table, because no scenario or test in
 * this lab needs a customer entity - only an order and its outbox event.
 */
export const orders = pgTable(
  "orders",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    customerName: text("customer_name").notNull(),
    amountCents: integer("amount_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("orders_amount_cents_positive", sql`${table.amountCents} > 0`)],
);

/**
 * The outbox table: one row per "an event needs to be published" intent,
 * decoupled from whether publishing has actually happened yet.
 * `published_at IS NULL` means "not yet published" - exactly the predicate
 * Lab 17's `SKIP LOCKED` publisher workers would poll on, even though this
 * lab only implements a one-shot, non-concurrent-safe drain script as a
 * preview (see `src/scripts/drain-outbox.ts`).
 *
 * `aggregate_id` is a real foreign key into `orders.id` here because this
 * lab only ever has one aggregate type (`order`). A production outbox table
 * that serves many aggregate types generally cannot carry a single FK like
 * this (the referenced table varies per row) - see README.md "Tradeoffs".
 *
 * `event_type`/`aggregate_type` CHECK constraints are deliberately narrow
 * (this lab only ever emits one event) so that a typo'd event/aggregate type
 * is a real, reproducible CHECK violation (SQLSTATE 23514) usable as the
 * "outbox insert itself fails" injection point in the transactional-outbox
 * scenario - see README.md "Break it" / "Fix it".
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: bigint("aggregate_id", { mode: "number" })
      .notNull()
      .references(() => orders.id),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    check("outbox_events_aggregate_type_valid", sql`${table.aggregateType} in ('order')`),
    check("outbox_events_event_type_valid", sql`${table.eventType} in ('OrderCreated')`),
  ],
);
