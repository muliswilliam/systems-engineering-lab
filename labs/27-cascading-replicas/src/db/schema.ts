import { pgTable, bigint, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * A deliberately minimal domain - same "small standalone table, the lesson
 * is the mechanism" rationale as Lab 06's `counters`/Lab 24's `widgets`/
 * Lab 26's `user_profiles`. This lab's subject is the cascading REPLICATION
 * TOPOLOGY and its propagation-lag/failure-mode mechanics, not a rich
 * relational model - a `widgets` row exists only to be something that can be
 * inserted on the primary and watched arrive, one hop at a time, at
 * replica-1 and then replica-2.
 *
 * Every DDL statement for this table is applied against the PRIMARY only
 * (see src/db/migrate.ts). Neither replica ever runs its own migration -
 * replica-1 receives this table's existence via physical WAL replay of the
 * primary, and replica-2 receives it via physical WAL replay of REPLICA-1's
 * own WAL stream (which is itself a re-forwarding of what replica-1 received
 * from the primary) - replica-2 never talks to the primary directly.
 */
export const widgets = pgTable("widgets", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  name: text("name").notNull(),
  value: integer("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
