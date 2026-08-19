import { pgTable, bigint, uuid, text, timestamp } from "drizzle-orm/pg-core";

/**
 * A fresh, standalone `page_views` table - NOT one of SPEC.md section 8.2's
 * five named domains. This lab is about the VACUUM/bloat MECHANISM, not a
 * rich relational model, the same "small standalone table, the lesson is the
 * mechanism" rationale as Lab 06's `counters`/Lab 11's `documents`/Lab 23's
 * `widgets`/Lab 30's `orders`.
 *
 * `view_count` is this lab's "hot column": a page-view counter that gets
 * incremented on every request to the same handful of popular URLs - a
 * completely realistic production pattern (analytics counters, account
 * balances, job-progress percentages all share the same shape: a small,
 * frequently-UPDATEd row). Every UPDATE to this column leaves the OLD tuple
 * version behind as a dead tuple until something vacuums it away - that
 * accumulation, and what happens when nothing ever vacuums it away, is this
 * lab's entire subject.
 *
 * Deliberately NOT Lab 06's `counters` table, despite the superficial
 * similarity - Lab 06 uses a single hand-picked row to inspect raw xmin/
 * xmax/ctid tuple mechanics via `pageinspect`. Lab 31 needs many thousands of
 * rows updated many times over, so REAL physical table growth and REAL
 * `pg_stat_user_tables` dead-tuple counts become measurable, not just a
 * single tuple's version chain. Per the independent-labs principle, this
 * schema is defined fresh here and shares no code or state with Lab 06.
 */
export const pageViews = pgTable("page_views", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  slug: text("slug").notNull(),
  viewCount: bigint("view_count", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
