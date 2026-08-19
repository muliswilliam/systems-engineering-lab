import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";

const log = createLogger("lab02:scenario:naive");

/**
 * A deliberately under-constrained pair of tables, created and dropped by
 * raw SQL rather than by Drizzle - this is the "naive" schema from
 * CLAUDE.md's "show failure before the fix". It intentionally omits:
 *
 * - the foreign key from employee -> company;
 * - the unique constraint on public_id;
 * - the CHECK on annual_salary_cents > 0;
 * - the CHECK restricting employment_status to a known set of values.
 *
 * It lives in its own `naive_companies` / `naive_employees` tables so it
 * never collides with the real, corrected `companies` / `employees` tables
 * that `src/db/schema.ts` manages - both can exist in the same database at
 * once, which is what lets this script and `corrected-inserts.ts` be run
 * back to back against the same `docker compose up -d` stack.
 */
export const NAIVE_DDL = `
  DROP TABLE IF EXISTS naive_employees;
  DROP TABLE IF EXISTS naive_companies;

  CREATE TABLE naive_companies (
    id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    public_id uuid,
    name text,
    country text,
    currency text
  );

  CREATE TABLE naive_employees (
    id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    public_id uuid,
    company_id bigint,
    full_name text,
    email text,
    role text,
    annual_salary_cents integer,
    currency text,
    employment_status text
  );
`;

export async function setupNaiveTables(pool: Pool): Promise<void> {
  await pool.query(NAIVE_DDL);
}

export interface NaiveAttemptResult {
  label: string;
  bypassedConstraint: string;
  succeeded: boolean;
  error?: string;
}

/**
 * Attempts the same four categories of bad data the corrected schema
 * rejects (see corrected-inserts.ts), against the naive tables. Every
 * attempt here is expected to SUCCEED - that is the point: none of these
 * invariants are actually enforced yet.
 */
export async function runNaiveBadInserts(pool: Pool): Promise<NaiveAttemptResult[]> {
  const results: NaiveAttemptResult[] = [];

  const attempt = async (
    label: string,
    bypassedConstraint: string,
    sql: string,
    params: unknown[],
  ): Promise<void> => {
    try {
      await pool.query(sql, params);
      results.push({ label, bypassedConstraint, succeeded: true });
    } catch (error) {
      results.push({
        label,
        bypassedConstraint,
        succeeded: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const {
    rows: [company],
  } = await pool.query<{ id: number }>(
    `INSERT INTO naive_companies (public_id, name, country, currency)
     VALUES (gen_random_uuid(), 'Naive Co', 'United States', 'USD')
     RETURNING id`,
  );

  await attempt(
    "employee references a company that does not exist",
    "foreign key (employees.company_id -> companies.id)",
    `INSERT INTO naive_employees
       (public_id, company_id, full_name, email, role, annual_salary_cents, currency, employment_status)
     VALUES (gen_random_uuid(), $1, 'Ghost Employee', 'ghost@example.com', 'engineer', 10000000, 'USD', 'active')`,
    [999_999_999],
  );

  const duplicatePublicId = "11111111-1111-1111-1111-111111111111";
  await attempt(
    "two companies share the same public_id",
    "unique constraint (companies.public_id)",
    `INSERT INTO naive_companies (public_id, name, country, currency)
     VALUES ($1, 'Duplicate Public ID Co', 'United States', 'USD')`,
    [duplicatePublicId],
  );
  // Insert it a second time to actually prove it's a duplicate, not a fluke.
  await attempt(
    "same public_id inserted again",
    "unique constraint (companies.public_id)",
    `INSERT INTO naive_companies (public_id, name, country, currency)
     VALUES ($1, 'Duplicate Public ID Co (again)', 'United States', 'USD')`,
    [duplicatePublicId],
  );

  await attempt(
    "employee has a negative salary",
    "check constraint (employees.annual_salary_cents > 0)",
    `INSERT INTO naive_employees
       (public_id, company_id, full_name, email, role, annual_salary_cents, currency, employment_status)
     VALUES (gen_random_uuid(), $1, 'Underpaid Employee', 'underpaid@example.com', 'engineer', -500000, 'USD', 'active')`,
    [company!.id],
  );

  await attempt(
    "employee has a nonsense employment_status",
    "check constraint (employees.employment_status IN ('active', 'terminated'))",
    `INSERT INTO naive_employees
       (public_id, company_id, full_name, email, role, annual_salary_cents, currency, employment_status)
     VALUES (gen_random_uuid(), $1, 'Schrodinger Employee', 'schrodinger@example.com', 'engineer', 10000000, 'USD', 'quantum_superposition')`,
    [company!.id],
  );

  return results;
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  log.info("creating naive_companies / naive_employees (no FK, no unique public_id, no CHECK)");
  await setupNaiveTables(pool);

  const results = await runNaiveBadInserts(pool);

  for (const result of results) {
    log.info(
      { bypassedConstraint: result.bypassedConstraint, succeeded: result.succeeded, error: result.error },
      result.label,
    );
  }

  const allSucceeded = results.every((r) => r.succeeded);
  log.warn(
    { allBadInsertsSucceeded: allSucceeded },
    allSucceeded
      ? "every bad insert succeeded against the naive schema - inspect naive_companies / naive_employees in PGweb, then run `pnpm scenario:fixed`"
      : "unexpected: at least one bad insert was rejected against the naive schema",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "naive scenario failed");
    process.exit(1);
  });
}
