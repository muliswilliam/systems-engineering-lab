import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { tenants, supportTickets } from "./db/schema.js";

const log = createLogger("lab39:dev");

/**
 * Connects as the MIGRATOR role, which owns these tables and therefore
 * bypasses Row-Level Security (see README "Break it") - so this overview,
 * unlike anything the `app`/`readonly` roles can see, always reports
 * totals across every tenant. Run the `scenario:*` scripts to see what
 * each non-owner role actually sees/can do.
 */
async function main() {
  await waitForDatabase(pool);

  const [tenantCount] = await db.select({ count: sql<number>`count(*)::int` }).from(tenants);
  const [ticketCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(supportTickets);

  log.info(
    {
      tenants: tenantCount?.count ?? 0,
      supportTickets: ticketCount?.count ?? 0,
    },
    "current database state (migrator/owner view - bypasses RLS)",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
