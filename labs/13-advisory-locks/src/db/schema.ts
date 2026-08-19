import { pgTable, bigint, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * A minimal slice of the payroll domain (SPEC.md ยง8.2), independent of Lab
 * 01's companies/employees tables per the independent-labs principle - this
 * lab defines and migrates its own copy, not an import.
 *
 * `payroll_runs` is the one row per company that "processing company N"
 * actually touches. It exists so this lab has something concrete to protect
 * (or fail to protect): advisory locks coordinate *who* is allowed to run a
 * company's payroll, but only a real constraint/transaction against this
 * table can protect its data - see
 * src/scenarios/advisory-lock-does-not-protect-rows.ts and
 * docs/architecture-principles.md ยง2 "Coordination vs correctness". This is
 * deliberately "one current run per company" (a UNIQUE `company_id`), not a
 * full payroll-period history - a richer model would only add noise around
 * the locking mechanics this lab teaches.
 */
export const companies = pgTable("companies", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(),
  name: text("name").notNull().unique(),
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

export const payrollRuns = pgTable("payroll_runs", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  companyId: bigint("company_id", { mode: "number" })
    .notNull()
    .unique()
    .references(() => companies.id),
  status: text("status").notNull().default("pending"),
  totalCents: integer("total_cents").notNull().default(0),
  processedByWorker: text("processed_by_worker"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
