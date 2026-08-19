import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, check } from "drizzle-orm/pg-core";

/**
 * A minimal banking-flavored domain on purpose: this lab is about isolation
 * semantics (what one transaction can and cannot observe about another
 * transaction's writes), not about a rich relational schema. A single
 * `accounts` table with a mutable `balance_cents` column is enough to drive
 * every experiment - read the same row twice, race a concurrent committed
 * update against an open transaction, and never see an uncommitted write.
 *
 * Every row still carries the repository's usual internal bigint identity
 * plus a public uuid (see docs/architecture-principles.md), even though this
 * lab has no external API surface - consistency with every other lab beats
 * saving two columns.
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
