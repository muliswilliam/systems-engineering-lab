import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, check } from "drizzle-orm/pg-core";

/**
 * Commerce domain for Lab 03: customers, products, orders, order_lines.
 *
 * This lab is not about relational modeling or constraints (that's Lab 02) -
 * it exists to make joins, aggregations, CTEs, window functions, and
 * subqueries fluent before the concurrency/locking labs need SQL to be a
 * non-issue. Commerce was chosen over payroll because it naturally supports
 * a *multi-level* join (customers -> orders -> order_lines -> products) and
 * a genuine one-to-many-to-many fan-out, which is exactly the shape that
 * produces the join-fan-out double-counting bug this lab's "Break it" /
 * "Fix it" sections are built around. See README.md "Scenario".
 *
 * No indexes are added in this lab on purpose - every query in this lab
 * plans as a sequential scan. Index tuning is Lab 04's job.
 */
export const customers = pgTable("customers", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  fullName: text("full_name").notNull(),
  email: text("email").notNull().unique(),
  country: text("country").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable(
  "products",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    sku: text("sku").notNull().unique(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("products_unit_price_cents_positive", sql`${table.unitPriceCents} > 0`)],
);

export const orders = pgTable(
  "orders",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    customerId: bigint("customer_id", { mode: "number" })
      .notNull()
      .references(() => customers.id),
    status: text("status").notNull().default("paid"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("orders_status_valid", sql`${table.status} in ('pending', 'paid', 'shipped', 'cancelled')`),
  ],
);

/**
 * `unitPriceCents` here is a *snapshot* of the product's price at order
 * time, not a live reference to `products.unit_price_cents` - the same way
 * a real checkout freezes the price the customer agreed to pay, so a later
 * price change never rewrites history. `lineTotalCents` is redundant with
 * `quantity * unitPriceCents`, but the CHECK constraint below keeps that
 * redundancy honest instead of trusting every future writer to compute it
 * correctly.
 */
export const orderLines = pgTable(
  "order_lines",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orderId: bigint("order_id", { mode: "number" })
      .notNull()
      .references(() => orders.id),
    productId: bigint("product_id", { mode: "number" })
      .notNull()
      .references(() => products.id),
    quantity: integer("quantity").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    lineTotalCents: integer("line_total_cents").notNull(),
  },
  (table) => [
    check("order_lines_quantity_positive", sql`${table.quantity} > 0`),
    check("order_lines_unit_price_cents_positive", sql`${table.unitPriceCents} > 0`),
    check(
      "order_lines_total_matches_quantity_times_price",
      sql`${table.lineTotalCents} = ${table.quantity} * ${table.unitPriceCents}`,
    ),
  ],
);
