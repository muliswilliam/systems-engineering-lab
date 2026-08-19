import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { counters } from "./db/schema.js";

const log = createLogger("lab06:dev");

async function main() {
  await waitForDatabase(pool);

  const rows = await db
    .select({ label: counters.label, value: counters.value, xmin: sql<string>`xmin::text`, ctid: sql<string>`ctid::text` })
    .from(counters)
    .orderBy(counters.label);

  log.info({ counters: rows }, "current database state");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
