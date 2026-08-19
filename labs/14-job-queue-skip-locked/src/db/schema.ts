import { sql } from "drizzle-orm";
import {
  pgTable,
  bigint,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  check,
  index,
} from "drizzle-orm/pg-core";

/**
 * Background-processing domain (SPEC.md 8.2), new in this lab. SPEC.md lists
 * "jobs; attempts; workers; schedules" as the domain's entities, but this lab
 * deliberately does NOT create a `workers` table - see "Why no `workers`
 * table?" in README.md "Architecture". Workers here are ephemeral
 * processes/loops identified only by a `worker_id` string (e.g.
 * `"worker-3"`), never persisted as rows of their own. `schedules` (recurring
 * jobs) is out of scope - this lab is about claiming and processing
 * already-enqueued one-shot jobs, not a cron-style scheduler.
 *
 * Claim/lease/retry state lives directly on `jobs`:
 *   - `status`        'pending' | 'processing' | 'completed' | 'failed'
 *   - `attempts`      incremented every time a worker claims the job
 *   - `max_attempts`  once `attempts` reaches this on a failure, the job
 *                      moves to the terminal 'failed' status instead of back
 *                      to 'pending'
 *   - `locked_by`     the worker_id currently holding the job (NULL unless
 *                      status = 'processing')
 *   - `locked_until`  the lease expiry - a worker that crashes or hangs
 *                      after claiming a job never clears this column, so once
 *                      `now() > locked_until` the job becomes reclaimable by
 *                      another worker even though its status is still
 *                      'processing'. See src/queue/claim.ts.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    jobType: text("job_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("jobs_status_valid", sql`${table.status} in ('pending', 'processing', 'completed', 'failed')`),
    check("jobs_attempts_non_negative", sql`${table.attempts} >= 0`),
    check("jobs_max_attempts_positive", sql`${table.maxAttempts} > 0`),
    // The claim query filters on status (+ locked_until for the
    // already-processing/expired-lease branch) and orders by created_at -
    // this composite index is what keeps that query an index scan instead of
    // a sequential scan as the table grows past a handful of rows.
    index("jobs_status_created_at_idx").on(table.status, table.createdAt),
  ],
);

/**
 * One row per claim (not per job) - a job that is retried 3 times has 3
 * `job_attempts` rows. This is the audit trail the concurrency tests use to
 * prove no two workers ever held the same job at the same time (see
 * tests/integration/no-double-processing.test.ts: no two 'claimed' rows for
 * the same job may have overlapping [claimed_at, released_at) windows).
 *
 * `status`:
 *   - `claimed`   a worker currently holds this attempt open (processing).
 *   - `completed` the worker finished the job successfully.
 *   - `failed`    the worker's processing threw, and this specific attempt
 *                 is recorded as failed (the job itself may still be
 *                 retried - see jobs.status).
 *   - `expired`   this attempt's lease ran out before the worker holding it
 *                 called complete/fail, and a different worker reclaimed the
 *                 job. This attempt is never touched again once marked
 *                 `expired` - it is a permanent record that a worker
 *                 crashed/hung while holding it.
 */
export const jobAttempts = pgTable(
  "job_attempts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => jobs.id),
    workerId: text("worker_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => [
    check(
      "job_attempts_status_valid",
      sql`${table.status} in ('claimed', 'completed', 'failed', 'expired')`,
    ),
    index("job_attempts_job_id_idx").on(table.jobId),
  ],
);
