import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, check } from "drizzle-orm/pg-core";

/**
 * Commerce domain, reused in SHAPE from Lab 03/04 (customers, products,
 * orders, order_lines) - a fresh, independent copy per the independent-labs
 * principle, not imported from either lab. See
 * packages/data-generators/src/commerce.ts for the generators this lab
 * reuses as-is.
 *
 * This lab adds exactly one new column beyond the Lab 03/04 shape:
 * `orders.channel` (web/mobile/phone/store). It exists specifically to give
 * Pattern 1b (correlated-columns row-estimate error) a second categorical
 * column that is deliberately correlated with `status` at the DATA level
 * (see src/seed/seed.ts) - `channel` is generated locally in this lab's own
 * seed script, not added to the shared `generateOrders`/`generateOrdersBatched`
 * generators, since no other lab needs it (same "generate the
 * lab-specific column separately" pattern Lab 25 used for `stock_quantity`).
 *
 * As in Lab 04, this lab's performance indexes and its one extended
 * statistics object are NOT declared here as Drizzle builders - they live in
 * the hand-written raw SQL migration `drizzle/0001_add_tuning_fixes.sql`
 * instead (partial/expression indexes and `CREATE STATISTICS` have
 * inconsistent/no drizzle-kit support). See that file and README.md
 * "Architecture" for the reasoning.
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
    // See seed.ts: channel is generated locally, correlated with status on
    // purpose (Pattern 1b), not part of the shared @labs/data-generators
    // commerce generator.
    channel: text("channel").notNull().default("web"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("orders_status_valid", sql`${table.status} in ('pending', 'paid', 'shipped', 'cancelled')`),
    check("orders_channel_valid", sql`${table.channel} in ('web', 'mobile', 'phone', 'store')`),
  ],
);

/**
 * `unitPriceCents` here is a *snapshot* of the product's price at order
 * time, not a live reference to `products.unit_price_cents` - same
 * convention as Lab 03/04.
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
