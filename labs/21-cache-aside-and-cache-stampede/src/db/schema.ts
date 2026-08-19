import { pgTable, bigint, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * The "source of truth" this whole lab is protecting behind a cache -
 * intentionally minimal (SPEC.md's commerce domain, trimmed down the same
 * way Lab 06's `counters`/Lab 11's `documents` are: the lesson here is cache
 * behavior, not a rich relational product catalog). Every entity still
 * carries both an internal bigint identity and an externally-facing UUID
 * per docs/architecture-principles.md #8.
 */
export const products = pgTable("products", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
