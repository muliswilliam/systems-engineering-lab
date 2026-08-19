import { pgTable, bigint, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * A deliberately minimal domain - this lab is about replication mechanics
 * (WAL, LSN, streaming, replay), not data modeling. A `widgets` row exists
 * only to be something that can be inserted on the primary and watched
 * arrive on the replica.
 *
 * Every DDL statement for this table is applied against the PRIMARY only
 * (see src/db/migrate.ts). The replica never runs its own migration - it
 * receives this table's existence via physical WAL replay of the primary's
 * base backup and subsequent WAL stream, which is the whole point of the
 * lab: physical replication ships raw changes to on-disk pages, not SQL
 * statements.
 */
export const widgets = pgTable("widgets", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  name: text("name").notNull(),
  value: integer("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
