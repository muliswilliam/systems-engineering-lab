import { pgTable, bigint, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * The classic "on-call staff" domain (SPEC.md Lab 09): a `team` has several
 * staff rows, each with a mutable `is_on_call` flag, and the business
 * invariant is "at least one staff member per team must be on call at all
 * times" - a rota can never go fully unstaffed.
 *
 * This invariant spans MULTIPLE ROWS (the whole team), which is exactly why
 * it cannot be expressed as a row-level Postgres `CHECK` constraint - a
 * `CHECK` only ever sees the row being written, never its siblings. There is
 * no `CHECK` anywhere in this schema on purpose: the entire lab is about
 * which *transactional* mechanism protects a cross-row invariant that the
 * datastore's declarative constraints cannot express directly (a `CHECK`,
 * an `EXCLUDE` constraint, and a trigger are the usual alternatives - see
 * the README's "Tradeoffs" section for why this lab reaches for Serializable
 * instead).
 *
 * Every row still carries the repository's usual internal bigint identity
 * plus a public uuid (see docs/architecture-principles.md), even though this
 * lab has no external API surface - consistency with every other lab beats
 * saving two columns.
 */
export const onCallStaff = pgTable("on_call_staff", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  team: text("team").notNull(),
  name: text("name").notNull().unique(),
  isOnCall: boolean("is_on_call").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
