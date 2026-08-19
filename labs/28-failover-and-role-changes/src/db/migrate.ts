import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase } from "./primary-client.js";

const log = createLogger("lab28:migrate");

// Migrations run ONLY against the primary - see Lab 24's src/db/migrate.ts
// for the same rule and the same reasoning: a physical standby must never
// diverge from the primary's schema, it gets its schema via WAL replay.
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
