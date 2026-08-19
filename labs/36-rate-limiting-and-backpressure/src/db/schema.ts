import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, boolean, timestamp, check } from "drizzle-orm/pg-core";

/**
 * A fresh, standalone domain for this lab - not one of SPEC.md 8.2's five
 * named domains. This lab is about a generic "protect the service"
 * mechanism (rate limiting + backpressure), not a rich business domain, per
 * the task brief's own guidance - so the schema models the MECHANISM
 * directly (jobs waiting to be processed, a queue's own capacity state, and
 * a record of rate-limiter decisions) rather than payroll/ticketing/
 * commerce/banking/background-processing dressing.
 */

/**
 * The backpressure-protected work queue. Reuses the SAME shape and claiming
 * pattern Lab 14 (job-queue-skip-locked) established
 * (`SELECT ... FOR UPDATE SKIP LOCKED`) for consumption - see
 * src/backpressure/bounded-queue.ts - but this lab does NOT re-derive Lab
 * 14's retry/lease/crash-recovery machinery (no `attempts`/`locked_until`
 * columns here): Lab 36's own subject is capacity - whether the queue
 * accepts new work at all - not retry semantics, which Lab 14 already
 * covers in full.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    status: text("status").notNull().default("pending"),
    workerId: text("worker_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check("jobs_status_valid", sql`${table.status} in ('pending', 'processing', 'completed')`),
  ],
);

/**
 * A single-row table (id = 1, enforced by the seed script, never a second
 * row) holding the bounded queue's capacity and current pending count. The
 * capacity invariant - `pending_count` never exceeds `capacity` - is
 * enforced entirely inside PostgreSQL via a conditional `UPDATE ...
 * WHERE pending_count < capacity` (the same conditional-write idiom Lab 11
 * teaches), not by application-level counting, per CLAUDE.md's "prefer
 * datastore-native guarantees" principle. See
 * src/backpressure/bounded-queue.ts's `enqueue`.
 */
export const queueState = pgTable(
  "queue_state",
  {
    id: bigint("id", { mode: "number" }).primaryKey(),
    capacity: integer("capacity").notNull(),
    pendingCount: integer("pending_count").notNull().default(0),
  },
  (table) => [
    check("queue_state_capacity_positive", sql`${table.capacity} > 0`),
    check("queue_state_pending_count_non_negative", sql`${table.pendingCount} >= 0`),
    check("queue_state_pending_count_within_capacity", sql`${table.pendingCount} <= ${table.capacity}`),
  ],
);

/**
 * An observability record of every rate-limiter decision, purely so PGweb
 * has something real to show for the rate-limiting half of this lab (the
 * limiter state itself lives in Redis, not Postgres - see "Architecture" in
 * README.md for why). Not read back by any limiter logic itself.
 */
export const rateLimitEvents = pgTable("rate_limit_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  clientKey: text("client_key").notNull(),
  algorithm: text("algorithm").notNull(),
  allowed: boolean("allowed").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
