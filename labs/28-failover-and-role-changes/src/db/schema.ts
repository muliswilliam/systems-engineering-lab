import { pgTable, bigint, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * A deliberately minimal domain, same rationale as Lab 24's `widgets` (this
 * lab is about failover/promotion mechanics, not data modeling - not one of
 * SPEC.md section 8.2's five named domains). Defined independently in this
 * lab's own schema, not imported from Lab 24/25/26/27.
 *
 * All DDL runs against the PRIMARY only (see src/db/migrate.ts). The
 * replica receives this table via physical WAL replay - until the moment
 * this lab's failover scenario promotes it, at which point it becomes an
 * independent primary that could, from then on, run its own DDL directly.
 */
export const widgets = pgTable("widgets", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  name: text("name").notNull(),
  value: integer("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
