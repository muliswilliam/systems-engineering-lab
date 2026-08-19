import { inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, payrollRuns } from "../db/schema.js";
import { SCENARIO_COMPANIES } from "./scenario-companies.js";

/**
 * Idempotently makes sure the two fixed scenario companies (and their
 * `payroll_runs` row, required by the `company_id` FK/UNIQUE) exist, without
 * requiring a full `pnpm seed` run first. Used by integration tests so `pnpm
 * test` works against a freshly migrated (but not necessarily seeded)
 * database, the same pattern Lab 07's tests use for SCENARIO_ACCOUNTS.
 */
export async function ensureScenarioCompanies(): Promise<void> {
  await db
    .insert(companies)
    .values(SCENARIO_COMPANIES.map((c) => ({ name: c.name, country: c.country, currency: c.currency })))
    .onConflictDoNothing({ target: companies.name });

  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(
      inArray(
        companies.name,
        SCENARIO_COMPANIES.map((c) => c.name),
      ),
    );

  await db
    .insert(payrollRuns)
    .values(rows.map((r) => ({ companyId: r.id })))
    .onConflictDoNothing({ target: payrollRuns.companyId });
}
