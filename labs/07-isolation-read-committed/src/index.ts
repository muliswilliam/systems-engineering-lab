import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { accounts } from "./db/schema.js";

const log = createLogger("lab07:dev");

async function main() {
  await waitForDatabase(pool);

  const rows = await db
    .select({ name: accounts.name, balanceCents: accounts.balanceCents })
    .from(accounts)
    .orderBy(accounts.id);

  const countRow = await db.select({ count: sql<number>`count(*)::int` }).from(accounts);

  log.info(
    { accountCount: countRow[0]?.count ?? 0, accounts: rows },
    "current database state - run `pnpm seed` first if this list is empty",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
