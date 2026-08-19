import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { accounts, processedMessages } from "./db/schema.js";

const log = createLogger("lab18:dev");

async function main() {
  await waitForDatabase(pool);

  const [accountCount] = await db.select({ count: sql<number>`count(*)::int` }).from(accounts);
  const [totalBalance] = await db
    .select({ total: sql<number>`coalesce(sum(balance_cents), 0)::int` })
    .from(accounts);
  const [processedCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(processedMessages);

  log.info(
    {
      accountCount: accountCount?.count ?? 0,
      totalBalanceCents: totalBalance?.total ?? 0,
      processedMessageCount: processedCount?.count ?? 0,
    },
    "current database state",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
