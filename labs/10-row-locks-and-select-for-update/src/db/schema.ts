import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, check } from "drizzle-orm/pg-core";

/**
 * A deliberately minimal banking/ledger-flavored domain (SPEC.md 8.2): a
 * single `accounts` table with a mutable `balance_cents` column. This lab is
 * about row-locking *mechanics* - `SELECT ... FOR UPDATE`, `FOR SHARE`,
 * `NOWAIT`, `lock_timeout`, and what actually shows up in `pg_locks` /
 * `pg_stat_activity` while a transaction blocks - not about a rich
 * relational model. A withdrawal scenario against one row is the smallest
 * domain that has a genuine "two transactions, one row, read-then-write"
 * story, which is exactly what row-lock experiments need.
 *
 * This schema is defined independently of Lab 05's `accounts` (which also
 * models banking/ledger) and Lab 07's `accounts` (isolation levels) per the
 * repository's independent-labs principle - none of the three tables are
 * shared, and none of this lab's code imports from Lab 05 or Lab 07.
 *
 * `balance_cents` carries `CHECK (balance_cents >= 0)` - Postgres itself
 * refuses to let any single UPDATE leave an account negative. That
 * constraint is real and always enforced, but on its own it does NOT protect
 * against the lost-update race this lab demonstrates: two concurrent
 * withdrawals can each independently satisfy the CHECK and still lose one of
 * the two withdrawals, because the invariant "two debits should reflect the
 * sum of both debits" spans two statements, not one. See README.md "Break
 * it" / "Why the fix works".
 */
export const accounts = pgTable(
  "accounts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    ownerName: text("owner_name").notNull(),
    balanceCents: integer("balance_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("accounts_balance_cents_non_negative", sql`${table.balanceCents} >= 0`)],
);
