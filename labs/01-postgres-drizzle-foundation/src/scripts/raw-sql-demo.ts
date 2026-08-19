import { eq } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { companies, employees } from "../db/schema.js";

const log = createLogger("lab01:raw-sql-demo");

/**
 * Runs the same query two ways so the SQL Drizzle generates is never a
 * mystery: once through the Drizzle query builder, once as hand-written SQL
 * against the same pg Pool. Compare this output with `docker compose logs
 * postgres` (log_statement=all) to see the exact statement Drizzle sent.
 */
async function main() {
  await waitForDatabase(pool);

  const [company] = await db.select().from(companies).limit(1);
  if (!company) {
    log.warn("no companies found - run `pnpm seed` first");
    await pool.end();
    return;
  }

  log.info({ company }, "picked a company via Drizzle");

  const drizzleResult = await db
    .select({
      id: employees.id,
      fullName: employees.fullName,
      annualSalaryCents: employees.annualSalaryCents,
    })
    .from(employees)
    .where(eq(employees.companyId, company.id))
    .orderBy(employees.annualSalaryCents);

  log.info({ count: drizzleResult.length }, "Drizzle: employees ordered by salary");

  const rawResult = await pool.query<{ id: number; full_name: string; annual_salary_cents: number }>(
    `SELECT id, full_name, annual_salary_cents
     FROM employees
     WHERE company_id = $1
     ORDER BY annual_salary_cents`,
    [company.id],
  );

  log.info({ count: rawResult.rowCount }, "raw SQL: employees ordered by salary");
  log.info(
    { agree: drizzleResult.length === rawResult.rowCount },
    "Drizzle and raw SQL returned the same row count",
  );

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "raw-sql-demo failed");
  process.exit(1);
});
