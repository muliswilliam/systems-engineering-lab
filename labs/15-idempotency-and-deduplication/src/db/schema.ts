import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, check } from "drizzle-orm/pg-core";

/**
 * A fresh, self-contained domain (SPEC.md 8.2's "Commerce" domain lists
 * `payments` as an entity, but this table is deliberately narrower and
 * shaped entirely around the one concept this lab teaches - idempotent
 * request handling - not a full order/checkout model. See Lab 06's
 * `counters` and Lab 11's `documents` for the same "small standalone table,
 * not one of the five named domains" rationale).
 *
 * `processPayment` (see src/scenarios/*.ts) never calls a real payment
 * processor - the INSERT into this table IS the side effect being protected
 * against duplication, exactly as CLAUDE.md's "show failure before the fix"
 * principle wants: the naive scenario's bug is a real second row in this
 * real table, not a mocked API call.
 *
 * `idempotency_key` is nullable and carries a plain UNIQUE constraint.
 * Postgres never considers two NULLs equal for a UNIQUE constraint (unless
 * `NULLS NOT DISTINCT` is used, which this table does not use), so many rows
 * with a NULL `idempotency_key` are allowed side by side - this is exactly
 * what lets `naive-retry.ts` demonstrate "no idempotency key at all" without
 * needing a second schema. The SAME table and the SAME unique constraint are
 * used by `idempotent-insert.ts`; the only thing that differs between the
 * naive and fixed scenarios is application behavior (does the client reuse
 * one key across retries, and does the server use `ON CONFLICT DO NOTHING`),
 * not the schema. That is deliberate: the unique constraint alone does
 * nothing if nobody supplies a stable key to it.
 */
export const payments = pgTable(
  "payments",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    idempotencyKey: text("idempotency_key").unique(),
    amountCents: integer("amount_cents").notNull(),
    payee: text("payee").notNull(),
    status: text("status").notNull().default("completed"),
    /**
     * Generated once, at processing time, by `cached-result-pattern.ts`'s
     * simulated payment processor. Deliberately non-deterministic (see that
     * file) so that "the retry returned the ORIGINAL value" and "the retry
     * recomputed a new value" are trivially distinguishable in a test or in
     * PGweb - two calls to the processor essentially never produce the same
     * confirmation code by chance.
     */
    confirmationCode: text("confirmation_code"),
    /** Also computed once at processing time, alongside `confirmationCode` -
     * see that column's comment. */
    processingFeeCents: integer("processing_fee_cents"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("payments_amount_cents_positive", sql`${table.amountCents} > 0`),
    check("payments_status_valid", sql`${table.status} in ('completed', 'failed')`),
  ],
);
