import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { jobs, queueState } from "./db/schema.js";

const log = createLogger("lab36:dev");

async function main() {
  await waitForDatabase(pool);

  const jobCounts = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.status);
  const state = await db.select().from(queueState);

  log.info({ jobCounts, queueState: state[0] }, "current database state");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
