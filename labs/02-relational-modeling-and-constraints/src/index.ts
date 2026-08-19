import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { companies, employees } from "./db/schema.js";

const log = createLogger("lab02:dev");

async function main() {
  await waitForDatabase(pool);

  const companyRows = await db.select({ count: sql<number>`count(*)::int` }).from(companies);
  const employeeRows = await db.select({ count: sql<number>`count(*)::int` }).from(employees);
  const statusRows = await db
    .select({ employmentStatus: employees.employmentStatus, count: sql<number>`count(*)::int` })
    .from(employees)
    .groupBy(employees.employmentStatus);

  log.info(
    {
      companyCount: companyRows[0]?.count ?? 0,
      employeeCount: employeeRows[0]?.count ?? 0,
      byEmploymentStatus: statusRows,
    },
    "current database state",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
