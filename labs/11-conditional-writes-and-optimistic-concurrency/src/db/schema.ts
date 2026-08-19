import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, check } from "drizzle-orm/pg-core";

/**
 * A minimal, deliberately standalone domain: a single editable "document" -
 * think a wiki page or a shared draft that two users can open and edit at
 * the same time. This is not one of SPEC.md 8.2's five named domains
 * (payroll/ticketing/commerce/banking/background-jobs) on purpose, the same
 * way Lab 06 introduced a standalone `counters` table - this lab is about
 * the concurrency-control *mechanism* (conditional writes, version columns),
 * not about a rich relational model. One mutable row with a `body` and a
 * `version` is enough to drive every experiment: a lost update, a version
 * conflict, a version-conflict retry, and a plain business-column
 * conditional write.
 *
 * `version` is the optimistic-concurrency column: every successful UPDATE
 * increments it, and `WHERE id = ? AND version = ?` is the conditional write
 * that only matches the row if nobody else's UPDATE got there first.
 *
 * `status` is unrelated to `version` - it exists to demonstrate a *plain*
 * conditional write on a business value (`WHERE status = 'draft'`), which is
 * optimistic concurrency control WITHOUT a dedicated version counter. It
 * only works when the WHERE condition itself IS the invariant being
 * protected (a state transition), not for "any concurrent edit should
 * conflict" - see README "Tradeoffs".
 */
export const documents = pgTable(
  "documents",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    title: text("title").notNull().unique(),
    body: text("body").notNull(),
    status: text("status").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("documents_version_positive", sql`${table.version} >= 1`),
    check("documents_status_valid", sql`${table.status} in ('draft', 'published')`),
  ],
);
