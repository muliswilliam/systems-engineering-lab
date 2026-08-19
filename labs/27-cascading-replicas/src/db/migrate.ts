import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase } from "./primary-client.js";

const log = createLogger("lab27:migrate");

// Migrations run ONLY against the primary. Never point this script (or
// drizzle.config.ts) at REPLICA1_DATABASE_URL/REPLICA2_DATABASE_URL - both
// standbys reject DDL the same way they reject any other write, and even if
// they didn't, neither may ever diverge from the primary's schema: they get
// it purely by replaying WAL (replica-1 from the primary, replica-2 from
// replica-1), not by running their own migration.
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
