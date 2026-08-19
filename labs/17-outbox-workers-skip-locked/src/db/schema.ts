import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, jsonb, check, index } from "drizzle-orm/pg-core";

/**
 * The publishing side of a transactional outbox (SPEC.md Lab 17 / CLAUDE.md
 * "Transactional Outbox" + "Job Queues"). This lab does NOT model the write
 * side (`BEGIN / INSERT order / INSERT outbox_event / COMMIT`, Lab 16's job)
 * - `outbox_events` rows are seeded directly, as if some other, already-
 * correct process had already written them. See src/seed/seed.ts.
 *
 * `status` lifecycle:
 *   pending    -> claimable by any worker.
 *   processing -> claimed by `locked_by`, lease held until `locked_until`.
 *                 Reclaimable by ANY worker (including a different one) once
 *                 `locked_until` is in the past - this is what models a
 *                 crashed publisher (see README "Break it").
 *   published  -> terminal, successful. `published_at` set.
 *   failed     -> terminal, unsuccessful. Reached only after `attempts`
 *                 exceeds `max_attempts` on a broker failure - never claimed
 *                 again.
 *
 * `attempts` increments every time a worker CLAIMS the row (not every time
 * the broker is called) - see src/queue/claim-and-publish.ts.
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "outbox_events_status_valid",
      sql`${table.status} in ('pending', 'processing', 'published', 'failed')`,
    ),
    check("outbox_events_attempts_non_negative", sql`${table.attempts} >= 0`),
    check("outbox_events_max_attempts_positive", sql`${table.maxAttempts} > 0`),
    // Supports the claim query's WHERE (status='pending' OR (status='processing'
    // AND locked_until < now())) ORDER BY created_at - see CLAUDE.md's "Job
    // Queues" section on preferring readable SQL alongside Drizzle.
    index("outbox_events_status_created_at_idx").on(table.status, table.createdAt),
  ],
);

/**
 * A deliberately minimal PREVIEW of Lab 18's inbox pattern - NOT a full
 * implementation (see README "Fix it" for exactly what is and is not covered
 * here). In a real system this table would live in the CONSUMER's own
 * database, not the producer's - it is included in this lab's schema only so
 * the preview scenario has somewhere to write to. No foreign key to
 * `outbox_events` on purpose: a real consumer's dedup table cannot reference
 * a row in a different service's database.
 */
export const processedEvents = pgTable("processed_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  eventPublicId: uuid("event_public_id").notNull().unique(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});
