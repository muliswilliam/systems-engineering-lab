import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";

const log = createLogger("lab02:scenario:fixed");

/** Marker used so this script's rows are easy to find and delete on rerun. */
const MARKER_EMAIL_DOMAIN = "corrected-scenario.example";
const MARKER_COMPANY_NAME = "Corrected Scenario Co";
const MARKER_PUBLIC_ID = "22222222-2222-2222-2222-222222222222";

export interface CorrectedAttemptResult {
  label: string;
  enforcedConstraint: string;
  rejected: boolean;
  postgresErrorCode?: string;
  message?: string;
}

async function cleanup(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM employees WHERE email LIKE $1`, [`%@${MARKER_EMAIL_DOMAIN}`]);
  await pool.query(`DELETE FROM companies WHERE name = $1 OR public_id = $2`, [
    MARKER_COMPANY_NAME,
    MARKER_PUBLIC_ID,
  ]);
}

/**
 * Runs the same four categories of bad insert as naive-inserts.ts, but
 * against the real, migration-managed `companies` / `employees` tables.
 * Every attempt here is expected to be REJECTED, and by a specific Postgres
 * error class - see
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 *
 *   23502  not_null_violation
 *   23503  foreign_key_violation
 *   23505  unique_violation
 *   23514  check_violation
 *
 * A final step demonstrates what CHECK does *not* protect: a legal-looking
 * UPDATE that flips `employment_status` from 'terminated' back to 'active'
 * succeeds, because CHECK only validates the row's new value in isolation -
 * it has no memory of the row's previous state. Preventing that transition
 * requires either a trigger or an application/state-machine rule (Lab 12).
 */
export async function runCorrectedBadInserts(pool: Pool): Promise<CorrectedAttemptResult[]> {
  await cleanup(pool);
  const results: CorrectedAttemptResult[] = [];

  const attempt = async (
    label: string,
    enforcedConstraint: string,
    sql: string,
    params: unknown[],
  ): Promise<void> => {
    try {
      await pool.query(sql, params);
      results.push({ label, enforcedConstraint, rejected: false });
    } catch (error) {
      const pgError = error as { code?: string; message?: string };
      results.push({
        label,
        enforcedConstraint,
        rejected: true,
        postgresErrorCode: pgError.code,
        message: pgError.message,
      });
    }
  };

  const {
    rows: [company],
  } = await pool.query<{ id: number }>(
    `INSERT INTO companies (name, country, currency) VALUES ($1, 'United States', 'USD') RETURNING id`,
    [MARKER_COMPANY_NAME],
  );

  await attempt(
    "employee references a company that does not exist",
    "foreign key (employees.company_id -> companies.id), error 23503",
    `INSERT INTO employees (company_id, full_name, email, role, annual_salary_cents, currency, employment_status)
     VALUES ($1, 'Ghost Employee', $2, 'engineer', 10000000, 'USD', 'active')`,
    [999_999_999, `ghost@${MARKER_EMAIL_DOMAIN}`],
  );

  await attempt(
    "second company reuses an existing public_id",
    "unique constraint (companies.public_id), error 23505",
    `INSERT INTO companies (public_id, name, country, currency) VALUES ($1, $2, 'United States', 'USD')`,
    [MARKER_PUBLIC_ID, `${MARKER_COMPANY_NAME} (duplicate public_id, attempt 1)`],
  );
  await attempt(
    "same public_id inserted again",
    "unique constraint (companies.public_id), error 23505",
    `INSERT INTO companies (public_id, name, country, currency) VALUES ($1, $2, 'United States', 'USD')`,
    [MARKER_PUBLIC_ID, `${MARKER_COMPANY_NAME} (duplicate public_id, attempt 2)`],
  );

  const duplicateEmail = `duplicate@${MARKER_EMAIL_DOMAIN}`;
  await attempt(
    "first employee claims an email address",
    "n/a - this insert is expected to succeed",
    `INSERT INTO employees (company_id, full_name, email, role, annual_salary_cents, currency, employment_status)
     VALUES ($1, 'First Claimant', $2, 'engineer', 10000000, 'USD', 'active')`,
    [company!.id, duplicateEmail],
  );
  await attempt(
    "second employee reuses that email address",
    "unique constraint (employees.email), error 23505",
    `INSERT INTO employees (company_id, full_name, email, role, annual_salary_cents, currency, employment_status)
     VALUES ($1, 'Second Claimant', $2, 'engineer', 10000000, 'USD', 'active')`,
    [company!.id, duplicateEmail],
  );

  await attempt(
    "employee has a negative salary",
    "check constraint (employees.annual_salary_cents > 0), error 23514",
    `INSERT INTO employees (company_id, full_name, email, role, annual_salary_cents, currency, employment_status)
     VALUES ($1, 'Underpaid Employee', $2, 'engineer', -500000, 'USD', 'active')`,
    [company!.id, `underpaid@${MARKER_EMAIL_DOMAIN}`],
  );

  await attempt(
    "employee has a nonsense employment_status",
    "check constraint (employees.employment_status IN ('active', 'terminated')), error 23514",
    `INSERT INTO employees (company_id, full_name, email, role, annual_salary_cents, currency, employment_status)
     VALUES ($1, 'Schrodinger Employee', $2, 'engineer', 10000000, 'USD', 'quantum_superposition')`,
    [company!.id, `schrodinger@${MARKER_EMAIL_DOMAIN}`],
  );

  await attempt(
    "employee is missing a required full_name",
    "not-null constraint (employees.full_name), error 23502",
    `INSERT INTO employees (company_id, full_name, email, role, annual_salary_cents, currency, employment_status)
     VALUES ($1, NULL, $2, 'engineer', 10000000, 'USD', 'active')`,
    [company!.id, `nameless@${MARKER_EMAIL_DOMAIN}`],
  );

  // --- The transition case: CHECK restricts values, not transitions. ---
  const terminatedEmail = `transition@${MARKER_EMAIL_DOMAIN}`;
  await attempt(
    "employee is hired and then terminated",
    "n/a - this insert is expected to succeed",
    `INSERT INTO employees (company_id, full_name, email, role, annual_salary_cents, currency, employment_status)
     VALUES ($1, 'Transition Employee', $2, 'engineer', 10000000, 'USD', 'terminated')`,
    [company!.id, terminatedEmail],
  );
  await attempt(
    "terminated employee is reactivated (terminated -> active)",
    "NOT enforced by CHECK - it only restricts the value set, not the transition",
    `UPDATE employees SET employment_status = 'active' WHERE email = $1`,
    [terminatedEmail],
  );

  return results;
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const results = await runCorrectedBadInserts(pool);

  for (const result of results) {
    log.info(
      {
        enforcedConstraint: result.enforcedConstraint,
        rejected: result.rejected,
        postgresErrorCode: result.postgresErrorCode,
      },
      result.label,
    );
  }

  await cleanup(pool);
  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ error }, "corrected scenario failed");
    process.exit(1);
  });
}
