import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { accounts } from "./db/schema.js";
import { getTrialPairs } from "./lib/trial-pairs.js";

const log = createLogger("lab32:dev");

async function main() {
  await waitForDatabase(pool);

  const [rowCount] = await db.select({ count: sql<number>`count(*)::int` }).from(accounts);
  const pairs = await getTrialPairs(pool);

  log.info(
    { totalAccounts: rowCount?.count ?? 0, trialPairCount: pairs.length },
    "current database state - run `pnpm scenario:deadlock`, `pnpm scenario:ordered`, `pnpm scenario:retry`, or `pnpm scenario:trials` next",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
