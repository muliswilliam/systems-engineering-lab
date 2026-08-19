import "dotenv/config";
import { Client } from "pg";
import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { loadSharedSql } from "../observability/db-sql.js";

const log = createLogger("lab38:scenario:postgres-inspection");

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

async function runLongRunningTransactionWorker(): Promise<void> {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  await client.query("SET application_name = 'lab38-long-running-worker'");
  await client.query("BEGIN");
  await client.query("SELECT pg_sleep(6)"); // exceeds show-long-running-transactions.sql's 5s threshold
  await client.query("ROLLBACK"); // leaves seeded data untouched
  await client.end();
}

async function runLockHolderWorker(): Promise<{ pid: number }> {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  await client.query("SET application_name = 'lab38-lock-holder'");
  const pidResult = await client.query("SELECT pg_backend_pid() AS pid");
  await client.query("BEGIN");
  await client.query("SELECT * FROM orders WHERE id = 1 FOR UPDATE");
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await client.query("ROLLBACK");
  await client.end();
  return { pid: pidResult.rows[0].pid };
}

async function runBlockedWriterWorker(): Promise<{ pid: number }> {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  await client.query("SET application_name = 'lab38-blocked-writer'");
  const pidResult = await client.query("SELECT pg_backend_pid() AS pid");
  // Gives the lock holder above a head start so this genuinely blocks.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await client.query("BEGIN");
  await client.query("UPDATE orders SET status = 'pending' WHERE id = 1");
  await client.query("ROLLBACK");
  await client.end();
  return { pid: pidResult.rows[0].pid };
}

async function printQuery(pool_: typeof pool, title: string, sqlFile: string): Promise<void> {
  const sql = loadSharedSql(sqlFile);
  const result = await pool_.query(sql);
  console.log(`\n=== ${title} (packages/db-utils/sql/${sqlFile}) ===`);
  if (result.rows.length === 0) {
    console.log("(no rows)");
  } else {
    console.table(result.rows);
  }
}

async function main() {
  await waitForDatabase(pool);
  const orderExists = await pool.query("SELECT 1 FROM orders WHERE id = 1");
  if (orderExists.rowCount === 0) {
    throw new Error("Run `pnpm seed` first - this scenario locks orders.id = 1.");
  }

  console.log("\n--- starting real concurrent Postgres activity: one long-running transaction, one row-lock holder, one blocked writer ---\n");

  // Fire all three concurrently - do NOT await sequentially, or there would
  // be nothing concurrent to inspect.
  const longRunning = runLongRunningTransactionWorker();
  const lockHolder = runLockHolderWorker();
  const blockedWriter = runBlockedWriterWorker();

  // Let all three reach their blocking/sleeping point before inspecting.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  await printQuery(pool, "Active transactions right now", "show-active-transactions.sql");
  await printQuery(pool, "Transactions open longer than 5 seconds", "show-long-running-transactions.sql");
  await printQuery(pool, "All locks currently held or awaited", "show-locks.sql");
  await printQuery(pool, "Who is blocking whom", "show-blocked-queries.sql");
  await printQuery(pool, "Live/dead tuple counts per table", "show-table-stats.sql");
  await printQuery(pool, "Index scan counts vs. size", "show-index-usage.sql");

  console.log(
    "\n(show-replication-lag.sql is intentionally not run here: this lab has a single Postgres " +
      "node with no replica, so pg_stat_replication is always empty - see Labs 25-27 for real replication lag.)",
  );

  const [, lockHolderResult, blockedWriterResult] = await Promise.all([longRunning, lockHolder, blockedWriter]);

  console.log(
    `\nWorker PIDs for cross-reference against the tables above: lock-holder=${lockHolderResult.pid}, blocked-writer=${blockedWriterResult.pid}`,
  );
  console.log(
    "An operator diagnosing a 'why is this query slow' ticket would run exactly these queries, in exactly this order: " +
      "pg_stat_activity to see WHAT is running, pg_locks/blocked-queries to see WHO is waiting on WHOM, and " +
      "pg_stat_user_tables/pg_stat_user_indexes to check whether the underlying table/index shape is itself a factor.",
  );

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "scenario failed");
  process.exit(1);
});
