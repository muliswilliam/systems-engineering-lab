import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { onCallStaff } from "./db/schema.js";

const log = createLogger("lab09:dev");

async function main() {
  await waitForDatabase(pool);

  const rows = await db
    .select({ team: onCallStaff.team, name: onCallStaff.name, isOnCall: onCallStaff.isOnCall })
    .from(onCallStaff)
    .orderBy(onCallStaff.team, onCallStaff.id);

  const countRow = await db.select({ count: sql<number>`count(*)::int` }).from(onCallStaff);

  log.info(
    { staffCount: countRow[0]?.count ?? 0, staff: rows },
    "current database state - run `pnpm seed` first if this list is empty",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
