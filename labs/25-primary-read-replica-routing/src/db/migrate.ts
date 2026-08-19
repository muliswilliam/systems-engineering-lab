import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase } from "./primary-client.js";

const log = createLogger("lab25:migrate");

// Migrations run ONLY against the primary - never point this script (or
// drizzle.config.ts) at REPLICA_DATABASE_URL. See Lab 24's migrate.ts for
// the full rationale (a physical standby rejects DDL like any other write,
// and must never diverge from the primary's schema by running its own
// migration instead of replaying WAL).
async function main() {
  await waitForDatabase(primaryPool);
  log.info("applying migrations to primary");
  await migrate(primaryDb, { migrationsFolder: "drizzle" });
  log.info("migrations applied to primary");
  await primaryPool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "migration failed");
  process.exit(1);
});
