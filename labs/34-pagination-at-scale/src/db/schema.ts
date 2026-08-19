import { pgTable, bigint, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * A fresh, standalone `activity_events` table - not one of SPEC.md section
 * 8.2's five named domains. Pagination-at-depth is a MECHANISM lesson (how
 * `OFFSET` and keyset pagination behave against a large, append-mostly,
 * chronologically-ordered table), not a rich relational model, the same
 * "small standalone table, the lesson is the mechanism" rationale as Lab
 * 06's `counters` / Lab 23's `widgets` / Lab 30's `orders` / Lab 31's
 * `page_views`. A platform activity feed (think: an admin audit log or a
 * public "recent activity" timeline) is the most natural real-world fit for
 * deep pagination: users and API clients genuinely do scroll or page deep
 * into feeds ordered by recency, which is exactly the shape this lab needs.
 *
 * `createdAt` is intentionally generated at whole-SECOND granularity (see
 * seed.ts) rather than full microsecond timestamp precision. A busy feed
 * genuinely logs multiple events in the same wall-clock second, and that is
 * precisely why `ORDER BY created_at` ALONE is not a valid total order - two
 * rows can tie on `created_at`, so both the naive and keyset queries in this
 * lab always order (and index) by the tuple `(created_at, id)`, using `id`
 * only as a deterministic tie-breaker. This is not a contrived edge case;
 * it is the normal state of any sufficiently active feed.
 *
 * Per the independent-labs principle, this schema shares no code or state
 * with any other lab's table.
 */
export const activityEvents = pgTable(
  "activity_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    actorName: text("actor_name").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // The ONE index this entire lab revolves around. Both the naive OFFSET
    // query and the keyset query use the exact same index - the point of
    // this lab is that the index does NOT save OFFSET from its O(offset)
    // scan-and-discard cost, while the SAME index gives keyset pagination
    // an O(log n) seek regardless of depth. See README "Why the fix works".
    index("activity_events_created_at_id_idx").on(table.createdAt, table.id),
  ],
);
