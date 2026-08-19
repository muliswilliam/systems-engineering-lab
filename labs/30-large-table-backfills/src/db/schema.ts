import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";

/**
 * A fresh, standalone `orders` table - NOT SPEC.md section 8.2's full
 * commerce model (customers/products/order_lines) and NOT imported from any
 * other lab's `orders` table (Lab 16, Lab 20). This lab is about the
 * MECHANICS of backfilling a very large table, not about a rich relational
 * domain - the same "small standalone table, the lesson is the mechanism"
 * rationale as Lab 06's `counters`/Lab 11's `documents`/Lab 23's `widgets`.
 * A flat table with a realistic commerce-shaped column set (customer email,
 * amount, status) is enough to make the backfill computation meaningful
 * without needing joins.
 *
 * `loyalty_points` is THIS LAB'S BACKFILL TARGET: a derived column computed
 * from `amount_cents` (1 point per whole dollar spent) that did not exist
 * when most of this table's rows were written. Lab 29 already taught that
 * `ALTER TABLE ... ADD COLUMN ... nullable` is an instant, pure-catalog
 * change regardless of table size - that step is deliberately NOT
 * re-demonstrated here. This lab starts from the point Lab 29 stopped: the
 * column already exists, every pre-existing row has `loyalty_points IS
 * NULL`, and now someone has to actually populate it for potentially a
 * million-plus rows without taking the table down. `packages/db-utils`'s
 * existing pattern is followed for structured logging and pool creation, but
 * no `@labs/data-generators` generator is added for this lab's `orders`
 * shape (same "no speculative shared machinery ahead of a second consumer"
 * reasoning as Lab 16/19/23's own standalone-schema Faker seed scripts).
 */
export const orders = pgTable(
  "orders",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    customerEmail: text("customer_email").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Nullable by design: this is the column every backfill scenario in this
     * lab exists to populate. `NULL` means "not yet backfilled." A partial
     * index on the NULL cohort keeps the batched backfill's own
     * `WHERE loyalty_points IS NULL ORDER BY id LIMIT $1` query fast even
     * once the table has a million rows and most of them are already done -
     * without it, that query would degrade into a sequential scan of the
     * whole table on every single batch.
     */
    loyaltyPoints: integer("loyalty_points"),
  },
  (table) => [
    index("idx_orders_loyalty_points_pending").on(table.id).where(sql`${table.loyaltyPoints} is null`),
  ],
);
