import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, check } from "drizzle-orm/pg-core";

/**
 * Commerce domain, reused from Lab 03 (customers, products, orders,
 * order_lines) rather than reinvented - see
 * packages/data-generators/src/commerce.ts. Lab 03 deliberately shipped this
 * schema with NO indexes beyond what PRIMARY KEY/UNIQUE force automatically,
 * so every query planned as a sequential scan. This lab is where that gets
 * fixed.
 *
 * IMPORTANT: the performance indexes this lab is actually about (B-tree,
 * composite, partial, covering/INCLUDE, expression) are NOT declared here as
 * Drizzle `index()` builders. They live entirely in the hand-written raw SQL
 * migration `drizzle/0001_add_performance_indexes.sql` instead. See that
 * file's header comment and README.md "Architecture" / "Why the fix works"
 * for the reasoning: partial/expression/covering indexes have inconsistent
 * support across drizzle-kit versions, and per CLAUDE.md's "ORM plus SQL"
 * principle, raw SQL is the clearer and more honest tool here - Postgres
 * uses these indexes transparently regardless of whether the TypeScript
 * schema object "knows" about them; only `EXPLAIN` and `pg_indexes` need to
 * agree with reality, not the ORM.
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
 * time, not a live reference to `products.unit_price_cents` - see Lab 03.
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
