import { pgTable, bigint, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Deliberately minimal domain for this lab: a single `counters` table
 * (think a page-view counter, a signup counter, ...) with one mutable
 * `value` column. See README "Scenario" for why this lab does not reuse the
 * payroll/commerce domains from Labs 01-04: MVCC visibility and tuple
 * versioning are properties of a single row's update history, and a rich
 * relational domain would only add noise around the thing actually being
 * observed (xmin/xmax/ctid on one row, across two sessions).
 *
 * Still carries the repo-wide bigint id + public uuid convention (see
 * docs/architecture-principles.md) even though nothing here is exposed
 * over an API - consistency with every other lab matters more than saving
 * two columns.
 */
export const counters = pgTable("counters", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  label: text("label").notNull().unique(),
  value: integer("value").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
