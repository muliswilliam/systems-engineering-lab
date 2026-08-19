import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, boolean, timestamp, check } from "drizzle-orm/pg-core";

/**
 * A fresh copy of Lab 07's minimal banking-flavored `accounts` table. Labs
 * are independent (CLAUDE.md 4.1) - this lab does not import Lab 07's
 * schema, client, or scenarios, even though the table is identical. This
 * table backs the first two scenarios:
 *   - repeatable-read-snapshot.ts: the same non-repeatable-read setup as
 *     Lab 07, but under REPEATABLE READ, to show the second read now
 *     returns the SAME (stale) value.
 *   - concurrent-write-conflict.ts: two REPEATABLE READ transactions racing
 *     to UPDATE the same row, to show Postgres raises a serialization
 *     failure (SQLSTATE 40001) instead of silently losing an update.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    name: text("name").notNull().unique(),
    balanceCents: integer("balance_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("accounts_balance_cents_non_negative", sql`${table.balanceCents} >= 0`)],
);

/**
 * The write-skew domain: the canonical "on-call staff" example from the
 * Postgres documentation (13.2.3 Serializable Isolation vs Repeatable Read
 * in the Postgres manual). A small set of staff rows, each with an
 * `is_on_call` flag. The cross-row invariant this table exists to protect -
 * "at least one row must have is_on_call = true" - is NOT expressible as a
 * single-row CHECK constraint or a simple UNIQUE index, because it spans
 * multiple rows. That is exactly what makes it a write-skew trap: Postgres
 * has no single-row constraint to violate, so nothing at the storage layer
 * objects when two concurrent Repeatable Read transactions each
 * independently (and, from their own snapshot, correctly) decide it is safe
 * for them to go off-call.
 *
 * Every row still carries the repository's usual internal bigint identity
 * plus a public uuid, consistent with every other lab, even though nothing
 * here has an external API surface.
 */
export const onCallStaff = pgTable("on_call_staff", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  name: text("name").notNull().unique(),
  isOnCall: boolean("is_on_call").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
