import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { documents } from "./db/schema.js";

const log = createLogger("lab11:dev");

async function main() {
  await waitForDatabase(pool);

  const rows = await db
    .select({
      title: documents.title,
      status: documents.status,
      version: documents.version,
    })
    .from(documents)
    .orderBy(documents.id);

  const countRow = await db.select({ count: sql<number>`count(*)::int` }).from(documents);

  log.info(
    { documentCount: countRow[0]?.count ?? 0, documents: rows },
    "current database state - run `pnpm seed` first if this list is empty",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
