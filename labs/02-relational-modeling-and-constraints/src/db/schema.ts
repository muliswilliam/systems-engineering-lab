import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, check } from "drizzle-orm/pg-core";

/**
 * This is the CORRECTED, fully-constrained schema for Lab 02 - the schema
 * that migrations, the seed script, and `pnpm dev` all use. The lab's
 * "naive" (under-constrained) counterpart is not a second Drizzle schema; it
 * is deliberately created and dropped by raw SQL in
 * `src/scenarios/naive-inserts.ts` so it never becomes the thing developers
 * actually build against. See README.md "Break it" / "Fix it".
 *
 * Every entity carries both an internal bigint identity (used for joins and,
 * in later labs, advisory-lock keys) and an externally-facing UUID
 * (`public_id`) - a surrogate key pair. `email` looks like a natural key
 * candidate for `employees` (real-world unique, meaningful on its own) but
 * email addresses change (marriage, rebranding, corrected typos) and are not
 * good join keys or URL-safe identifiers. The lab still enforces `email`
 * uniqueness as a business rule, but `id`/`public_id` remain the keys other
 * tables and external clients actually reference. See README "Natural vs
 * surrogate keys".
 */
export const companies = pgTable("companies", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  name: text("name").notNull(),
  country: text("country").notNull(),
  currency: text("currency").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * `employmentStatus` is restricted to a fixed set of values by CHECK, but a
 * CHECK constraint only restricts the *set* of legal values for a single
 * row - it cannot see the row's previous value, so it cannot stop an
 * otherwise-legal *transition* such as `terminated -> active`. See README
 * "Why the fix works" and "Break it" for why that distinction matters and
 * what a real fix (a trigger, or an application-level/state-machine check,
 * as built in Lab 12) would need to add.
 */
export const employees = pgTable(
  "employees",
  {
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
    employmentStatus: text("employment_status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("employees_annual_salary_cents_positive", sql`${table.annualSalaryCents} > 0`),
    check(
      "employees_employment_status_valid",
      sql`${table.employmentStatus} in ('active', 'terminated')`,
    ),
  ],
);
