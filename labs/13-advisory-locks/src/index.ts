import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { companies, employees, payrollRuns } from "./db/schema.js";

const log = createLogger("lab13:dev");

async function main() {
  await waitForDatabase(pool);

  const companyRows = await db.select({ count: sql<number>`count(*)::int` }).from(companies);
  const employeeRows = await db.select({ count: sql<number>`count(*)::int` }).from(employees);
  const payrollRunRows = await db.select({ count: sql<number>`count(*)::int` }).from(payrollRuns);

  log.info(
    {
      companyCount: companyRows[0]?.count ?? 0,
      employeeCount: employeeRows[0]?.count ?? 0,
      payrollRunCount: payrollRunRows[0]?.count ?? 0,
    },
    "current database state - run `pnpm seed` first if this is all zero",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
