import { pgTable, bigint, uuid, text, timestamp } from "drizzle-orm/pg-core";

/**
 * A single, deliberately small `user_profiles` table - this lab is about the
 * read-after-write consistency problem and its mitigations, not a rich
 * relational model. `display_name` is the field a user edits (the SPEC.md
 * Lab 26 "POST /profile" scenario), and `bio` exists only to make seeded
 * rows look like a real profile rather than a bare name column.
 *
 * Every DDL statement is applied against the PRIMARY only (see
 * src/db/migrate.ts). The replica receives this table via physical WAL
 * replay, exactly like Lab 24.
 */
export const userProfiles = pgTable("user_profiles", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  displayName: text("display_name").notNull(),
  bio: text("bio"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
