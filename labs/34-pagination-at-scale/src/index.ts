import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { activityEvents } from "./db/schema.js";

const log = createLogger("lab34:dev");

async function main() {
  await waitForDatabase(pool);

  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(activityEvents);
  const [range] = await db
    .select({
      minCreatedAt: sql<string | null>`min(created_at)`,
      maxCreatedAt: sql<string | null>`max(created_at)`,
    })
    .from(activityEvents);

  log.info(
    {
      eventCount: row?.count ?? 0,
      minCreatedAt: range?.minCreatedAt ?? null,
      maxCreatedAt: range?.maxCreatedAt ?? null,
    },
    "current activity_events state - run `pnpm scenario:offset`, `pnpm scenario:keyset`, `pnpm scenario:correctness-bug`, `pnpm scenario:keyset-correctness`, or `pnpm scenario:count-cost` next",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
