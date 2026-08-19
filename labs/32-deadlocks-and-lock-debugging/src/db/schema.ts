import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, check } from "drizzle-orm/pg-core";

/**
 * A fresh, independent banking/ledger `accounts` table - the SAME minimal
 * shape Lab 05/07/08/10/18 each define independently for their own
 * concurrency concept (per the repository's independent-labs principle, none
 * of those tables - or this one - are shared or imported across labs).
 * "Transfer money between two accounts, locking both" is the textbook
 * deadlock scenario: two transactions each lock one account first and then
 * request the other's lock, in opposite order - exactly the row-lock
 * primitive Lab 10 already teaches, now composed two-at-a-time to produce a
 * genuine wait-for CYCLE instead of a one-directional block.
 *
 * No `transfers`/audit table is added here - unlike Lab 05's `transfers` or
 * Lab 20's `saga_log`, this lab's subject (deadlock formation and detection)
 * is entirely about `pg_locks`/`pg_stat_activity` state and the real
 * SQLSTATE 40P01 error Postgres returns, not application-level bookkeeping,
 * so an attempts/audit table would add schema noise without serving the
 * concept - see CLAUDE.md's "avoid dependency sprawl" / "minimal abstraction
 * in educational code" guidance.
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
