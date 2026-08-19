import { pgTable, bigint, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * A fresh, minimal schema - this lab is about connection and pooling
 * mechanics, not data modeling, so one small table is enough. Same internal
 * bigint / external uuid split every other lab uses (docs/architecture-
 * principles.md).
 */
export const widgets = pgTable("widgets", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  name: text("name").notNull(),
  value: integer("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
