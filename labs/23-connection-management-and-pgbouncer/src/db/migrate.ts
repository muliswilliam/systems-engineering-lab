import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./client.js";

const log = createLogger("lab23:migrate");

/**
 * Runs directly against Postgres (DATABASE_URL), never through
 * DATABASE_URL_PGBOUNCER_TRANSACTION. This is a real operational caveat,
 * not just this lab's convention: DDL wrapped in an implicit transaction can
 * interact badly with transaction-mode pooling. PgBouncer's transaction
 * pooling assumes each client transaction is short and hands the underlying
 * server connection to a different client the moment one transaction ends -
 * a schema-changing migration runner that also expects to hold session-level
 * state (advisory locks some migration tools take out, `SET
 * search_path`, prepared statements) across statements can silently get
 * handed a different backend mid-migration. Session pooling would avoid that
 * specific hazard, but there is no reason to add PgBouncer to the migration
 * path at all - a migration runner is not a pool of many short-lived client
 * connections, it is one connection doing one job, so it should just talk to
 * Postgres directly.
 */
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
