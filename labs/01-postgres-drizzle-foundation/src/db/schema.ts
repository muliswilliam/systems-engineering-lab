import { pgTable, bigint, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Every entity carries both an internal bigint identity (used for joins and,
 * in later labs, advisory-lock keys) and an externally-facing UUID
 * (`public_id`). See docs/architecture-principles.md for why both exist.
 */
export const companies = pgTable("companies", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  name: text("name").notNull(),
  country: text("country").notNull(),
  currency: text("currency").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const employees = pgTable("employees", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  companyId: bigint("company_id", { mode: "number" })
    .notNull()
    .references(() => companies.id),
  fullName: text("full_name").notNull(),
  email: text("email").notNull().unique(),
  role: text("role").notNull(),
  annualSalaryCents: integer("annual_salary_cents").notNull(),
  currency: text("currency").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
