import { sql } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "./db/client.js";
import { payments } from "./db/schema.js";

const log = createLogger("lab15:dev");

/**
 * Reports the state a reconciliation job would actually care about: not just
 * "how many payments exist" but "how many idempotency keys have more than
 * one row attached to them" - in production that query is exactly how you'd
 * discover the naive scenario's bug happening for real, without ever having
 * run this lab's own scenario scripts.
 */
async function main() {
  await waitForDatabase(pool);

  const totalRows = await db.select({ count: sql<number>`count(*)::int` }).from(payments);
  const nullKeyRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(payments)
    .where(sql`idempotency_key is null`);

  const duplicateKeys = await pool.query<{ idempotency_key: string; row_count: number }>(
    `SELECT idempotency_key, count(*)::int AS row_count
     FROM payments
     WHERE idempotency_key IS NOT NULL
     GROUP BY idempotency_key
     HAVING count(*) > 1
     ORDER BY row_count DESC`,
  );

  log.info(
    {
      totalPayments: totalRows[0]?.count ?? 0,
      paymentsWithNoIdempotencyKey: nullKeyRows[0]?.count ?? 0,
      idempotencyKeysWithMoreThanOneRow: duplicateKeys.rowCount,
    },
    "current database state",
  );

  if ((duplicateKeys.rowCount ?? 0) > 0) {
    log.warn(
      { duplicates: duplicateKeys.rows },
      "found idempotency keys with more than one row - this should be impossible given the UNIQUE constraint; investigate immediately",
    );
  }

  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "dev failed");
  process.exit(1);
});
