import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase } from "./primary-client.js";

const log = createLogger("lab24:migrate");

// Migrations run ONLY against the primary. Never point this script (or
// drizzle.config.ts) at REPLICA_DATABASE_URL - a physical standby rejects
// DDL the same way it rejects any other write, and even if it didn't, a
// physical replica must never diverge from the primary's schema: it gets
// its schema by replaying the primary's WAL, not by running its own
// migration.
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
