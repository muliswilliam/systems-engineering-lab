import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./client.js";

const log = createLogger("lab39:migrate");

// Runs AS the MIGRATOR role (DATABASE_URL points at it - see
// .env.example). Migration 0001 creates the tenant-isolation function,
// enables Row-Level Security, and creates the policies - all of which
// require owning the table, which the migrator role does because it is the
// role that created it in migration 0000. See README "Setup" for the full
// bootstrapping order (admin creates roles -> migrator creates
// schema+RLS -> app/readonly only ever consume what already exists).
async function main() {
  await waitForDatabase(pool);
  log.info("applying migrations as lab39_migrator");
  await migrate(db, { migrationsFolder: "drizzle" });
  log.info("migrations applied");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "migration failed");
  process.exit(1);
});
