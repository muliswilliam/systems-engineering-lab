import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { products } from "./db/schema.js";

const log = createLogger("lab21:dev");

async function main() {
  await waitForDatabase(pool);

  const productRows = await db.select({ count: sql<number>`count(*)::int` }).from(products);

  log.info({ productCount: productRows[0]?.count ?? 0 }, "current database state");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
