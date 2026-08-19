import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { companies, employees } from "./db/schema.js";

const log = createLogger("lab01:dev");

async function main() {
  await waitForDatabase(pool);

  const companyRows = await db.select({ count: sql<number>`count(*)::int` }).from(companies);
  const employeeRows = await db.select({ count: sql<number>`count(*)::int` }).from(employees);

  log.info(
    { companyCount: companyRows[0]?.count ?? 0, employeeCount: employeeRows[0]?.count ?? 0 },
    "current database state",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ error }, "dev failed");
  process.exit(1);
});
