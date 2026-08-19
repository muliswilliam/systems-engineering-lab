import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, check } from "drizzle-orm/pg-core";

/**
 * Banking/ledger domain (SPEC.md 8.2), a fresh independent copy of the
 * `accounts` shape Lab 05/07/08/10 also use - per the independent-labs
 * principle, none of these labs' `accounts` tables are shared or imported
 * between labs. This lab plays the role of a downstream *consumer*: some
 * upstream system (conceptually, Lab 17's outbox publishers) emits
 * `CreditApplied` events that name an account and an amount, and this
 * account is what receives the business effect of those events.
 *
 * `balance_cents` keeps the `CHECK (balance_cents >= 0)` guarantee from
 * Lab 05 - a genuinely useful, separate, single-row invariant that has
 * nothing to say about whether a given event was already applied. That
 * second invariant (has this specific message already been processed?) is
 * exactly what `processed_messages` below exists to protect, and it is
 * this lab's actual subject.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    ownerName: text("owner_name").notNull(),
    balanceCents: integer("balance_cents").notNull(),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("accounts_balance_cents_non_negative", sql`${table.balanceCents} >= 0`)],
);

/**
 * The inbox / deduplication table (SPEC.md "Lab 18" / CLAUDE.md
 * "Idempotency"). `message_id` is the incoming event's own unique ID - it is
 * the PRIMARY KEY, not merely a UNIQUE column, because this table has no
 * other reason to exist and no other natural key: its entire job is "have I
 * seen this message ID before?".
 *
 * `account_id`/`amount_cents` are stored (rather than just the bare
 * `message_id`) so PGweb and the tests can see exactly which business effect
 * a given message corresponded to, and so a real system could use this table
 * for post-hoc reconciliation ("which messages credited account 42?"),
 * matching the brief's "or account_id + amount_cents" option.
 *
 * The three scenario consumers in src/scenarios/ all read and write this
 * exact table - what differs between them is ONLY whether the check against
 * it, the insert into it, and the UPDATE against `accounts` happen inside
 * one atomic transaction. That difference is the entire lesson of this lab.
 */
export const processedMessages = pgTable(
  "processed_messages",
  {
    messageId: uuid("message_id").primaryKey(),
    accountId: bigint("account_id", { mode: "number" })
      .notNull()
      .references(() => accounts.id),
    amountCents: integer("amount_cents").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("processed_messages_amount_cents_positive", sql`${table.amountCents} > 0`)],
);
