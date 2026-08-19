import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { accounts, onCallStaff } from "./db/schema.js";

const log = createLogger("lab08:dev");

async function main() {
  await waitForDatabase(pool);

  const accountRows = await db
    .select({ name: accounts.name, balanceCents: accounts.balanceCents })
    .from(accounts)
    .orderBy(accounts.id);

  const staffRows = await db
    .select({ name: onCallStaff.name, isOnCall: onCallStaff.isOnCall })
    .from(onCallStaff)
    .orderBy(onCallStaff.id);

  const accountCountRow = await db.select({ count: sql<number>`count(*)::int` }).from(accounts);

  log.info(
    { accountCount: accountCountRow[0]?.count ?? 0, accounts: accountRows, onCallStaff: staffRows },
    "current database state - run `pnpm seed` first if these lists are empty",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
