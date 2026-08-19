import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, check } from "drizzle-orm/pg-core";

/**
 * Banking/ledger domain (SPEC.md 8.2), introduced in this lab because none of
 * the existing domains (payroll, commerce) have money-moving accounts. See
 * packages/data-generators/src/ledger.ts for the shared `generateAccounts`
 * generator - `transfers` below is scenario-specific to this lab (an audit
 * trail of transfer *attempts*, not a reusable generator) and is defined only
 * here.
 *
 * `balance_cents` carries a `CHECK (balance_cents >= 0)` - no overdrafts,
 * enforced by Postgres itself regardless of which code path writes the row.
 * This is deliberately a *single-row* guarantee: it stops any one UPDATE from
 * leaving an account negative, but it says nothing about whether a debit and
 * its matching credit happen together. That second guarantee is exactly what
 * this lab's naive vs transactional scenarios are about - see README.md
 * "Why the fix works".
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
 * One row per transfer *attempt*, not just per successful transfer - this is
 * the audit trail that lets the scenarios and tests prove what actually
 * happened to the money, instead of only asserting on account balances.
 *
 * `mechanism` distinguishes which code path produced the row
 * (`naive` = two independent statements, `transactional` = BEGIN/COMMIT/
 * ROLLBACK) so PGweb and the tests can tell the two scenarios' rows apart in
 * the same table.
 *
 * `status`:
 *   - `pending`   transfer started, outcome not yet known. For the
 *                 `transactional` mechanism this is always transient - it
 *                 either becomes `completed` or the whole row (including the
 *                 `pending` insert itself) is rolled back. For the `naive`
 *                 mechanism, a `pending` row that never becomes `completed`
 *                 IS the corruption: it means the debit statement already
 *                 committed independently and the process then "crashed"
 *                 (the injected failure) before the credit statement ever
 *                 ran - there is no code left to run that would mark it
 *                 `failed`, so it simply sits at `pending` forever. See
 *                 README.md "Break it".
 *   - `completed` both the debit and the credit are durable.
 *   - `failed`    (transactional mechanism only) the transaction was rolled
 *                 back; NEITHER the debit nor the credit is durable. This row
 *                 is inserted by a separate, already-committed statement
 *                 *after* the rollback - a row inserted inside the
 *                 rolled-back transaction would itself have been rolled
 *                 back, so there would be nothing left to record `failed`
 *                 onto.
 */
export const transfers = pgTable(
  "transfers",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    fromAccountId: bigint("from_account_id", { mode: "number" })
      .notNull()
      .references(() => accounts.id),
    toAccountId: bigint("to_account_id", { mode: "number" })
      .notNull()
      .references(() => accounts.id),
    amountCents: integer("amount_cents").notNull(),
    mechanism: text("mechanism").notNull(),
    status: text("status").notNull(),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check("transfers_amount_cents_positive", sql`${table.amountCents} > 0`),
    check("transfers_accounts_distinct", sql`${table.fromAccountId} <> ${table.toAccountId}`),
    check("transfers_mechanism_valid", sql`${table.mechanism} in ('naive', 'transactional')`),
    check("transfers_status_valid", sql`${table.status} in ('pending', 'completed', 'failed')`),
  ],
);
