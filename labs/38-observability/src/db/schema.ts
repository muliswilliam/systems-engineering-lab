import { pgTable, bigint, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * A fresh, standalone `orders` table - NOT Lab 03/04's `orders` (commerce
 * schema with `customers`/`products`/`order_lines`) and NOT Lab 20's
 * saga-oriented `orders`. This lab is about the OBSERVABILITY TOOLING
 * (structured logs, metrics, correlation IDs, Postgres inspection), not a
 * rich order domain, so the table is deliberately minimal - the same
 * "small standalone table, the lesson is the mechanism" rationale as Lab
 * 06's `counters`/Lab 11's `documents`/Lab 31's `page_views`. Per the
 * independent-labs principle this schema shares no code or state with any
 * other lab's `orders` table.
 *
 * `customer_email` is nullable on purpose: a small fraction of seeded rows
 * represent real "guest checkout" orders with no email on file. The lab's
 * business logic layer (`src/server/business-logic.ts`) derives an email
 * domain from this column without a null check - a real, reproducible bug
 * that throws for exactly those rows, which is what the error-bucket of
 * this lab's traffic mix demonstrates and what structured logging/tracing
 * is used to diagnose.
 */
export const orders = pgTable("orders", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  customerEmail: text("customer_email"),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull().default("completed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
