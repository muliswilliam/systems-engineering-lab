import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { pageViews } from "./db/schema.js";
import { getTableStats } from "./scenarios/pg-stats.js";

const log = createLogger("lab31:dev");

async function main() {
  await waitForDatabase(pool);

  const [rowCount] = await db.select({ count: sql<number>`count(*)::int` }).from(pageViews);
  const stats = await getTableStats(pool, "page_views");

  log.info(
    {
      pageViewCount: rowCount?.count ?? 0,
      relationSizeBytes: stats.relationSizeBytes,
      totalRelationSizeBytes: stats.totalRelationSizeBytes,
      liveTuples: stats.liveTuples,
      deadTuples: stats.deadTuples,
      lastVacuum: stats.lastVacuum,
      lastAutovacuum: stats.lastAutovacuum,
      vacuumCount: stats.vacuumCount,
      autovacuumCount: stats.autovacuumCount,
    },
    "current database state",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
