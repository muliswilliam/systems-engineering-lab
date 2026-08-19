import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { customers } from "./db/schema.js";

const log = createLogger("lab29:dev");

async function main() {
  await waitForDatabase(pool);

  const [customerCount] = await db.select({ count: sql<number>`count(*)::int` }).from(customers);
  const [displayNameBackfilled] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(customers)
    .where(sql`display_name is not null`);

  log.info(
    {
      customerCount: customerCount?.count ?? 0,
      displayNameBackfilled: displayNameBackfilled?.count ?? 0,
    },
    "current database state",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
