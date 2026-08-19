import { pgTable, bigint, uuid, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Commerce-adjacent domain (SPEC.md 8.2), reusing the shared
 * `generateCustomers` generator from packages/data-generators/src/commerce.ts
 * (publicId/fullName/email/country) - the same shape Lab 03/04's `customers`
 * table uses, though this is a fresh, independent table defined only in this
 * lab (no import from Lab 03/04, per the independent-labs principle).
 *
 * `full_name` is this lab's pre-migration baseline column (migration 0000).
 * `display_name` is added in migration 0001 as the "expand" step of the
 * expand/contract sequence this lab teaches - see README.md "Architecture"
 * and "Fix it". Both columns exist simultaneously in this table's final,
 * safe state: dropping `full_name` (the "contract" step) is explicitly out
 * of this lab's runnable scope (a later migration, once every application
 * instance is confirmed on the new column - see README).
 */
export const customers = pgTable("customers", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  fullName: text("full_name").notNull(),
  /**
   * Nullable by design (see README "Fix it" / CLAUDE.md's "Safe Migrations"):
   * `ADD COLUMN display_name text` with no default and no NOT NULL is a pure
   * catalog change - instant regardless of table size, because Postgres does
   * not need to rewrite existing rows or acquire a long-held lock to backfill
   * a value into them. It only becomes NOT NULL-equivalent once the backfill
   * (src/scenarios/expand-contract-migration.ts) has run for every existing
   * row.
   */
  displayName: text("display_name"),
  email: text("email").notNull().unique(),
  country: text("country").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
