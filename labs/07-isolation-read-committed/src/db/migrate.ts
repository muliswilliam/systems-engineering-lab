import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./client.js";

const log = createLogger("lab07:migrate");

async function main() {
  await waitForDatabase(pool);
  log.info("applying migrations");
  await migrate(db, { migrationsFolder: "drizzle" });
  log.info("migrations applied");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "migration failed");
  process.exit(1);
});
