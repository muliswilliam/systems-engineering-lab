import { pgTable, bigint, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * A minimal commerce-adjacent `products` table - just enough surface for
 * the four routing decisions this lab teaches:
 *
 * - `priceCents`/`stockQuantity` are mutated by WRITES (always primary);
 * - a plain catalog browse is an ORDINARY READ (replica is fine - a
 *   slightly stale price on a browse page is an acceptable tradeoff);
 * - reading the SAME row immediately after changing its price is a
 *   READ-AFTER-WRITE (must not silently show the pre-write value);
 * - decrementing `stockQuantity` during a purchase must read the CURRENT
 *   value and write the new one inside one TRANSACTION (must run entirely
 *   on the primary - see src/scenarios/transaction-must-run-on-primary.ts).
 *
 * Reuses the shape of the existing `generateProducts` generator in
 * `@labs/data-generators` (see src/seed/seed.ts) - `sku` is dropped since
 * this schema has no column for it, the same kind of partial reuse Lab 21
 * already did for its own `products` table.
 *
 * Every DDL statement for this table is applied against the PRIMARY only
 * (see src/db/migrate.ts) - the replica receives it via physical WAL
 * replay, exactly like Lab 24's `widgets` table.
 */
export const products = pgTable("products", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  priceCents: integer("price_cents").notNull(),
  stockQuantity: integer("stock_quantity").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
