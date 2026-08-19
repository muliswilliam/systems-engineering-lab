import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { resourceState } from "./db/schema.js";

const log = createLogger("lab22:dev");

async function main() {
  await waitForDatabase(pool);

  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(resourceState);

  log.info(
    { resourceStateCount: rows[0]?.count ?? 0 },
    "current database state - run `pnpm seed` first if this is zero, then try `pnpm scenario:*`",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
