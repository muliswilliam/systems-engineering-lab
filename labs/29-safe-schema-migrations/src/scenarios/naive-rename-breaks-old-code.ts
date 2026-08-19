import "dotenv/config";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createLogger } from "@labs/logging";

const log = createLogger("lab29:scenario:naive-rename");

export interface NaiveRenameIncidentResult {
  customerId: number;
  oldCodeValueBeforeRename: string;
  oldCodeErrorCode?: string;
  oldCodeErrorMessage?: string;
  newCodeValueAfterRename?: string;
}

/**
 * Simulates the OLD application code that is still running on some
 * instances during a rolling deploy. It has no idea a migration is about to
 * rename the column out from under it - it just issues the query it has
 * always issued.
 */
async function oldCodeReadFullName(client: Client, table: string, customerId: number): Promise<string> {
  const result = await client.query<{ full_name: string }>(
    `SELECT full_name FROM ${table} WHERE id = $1`,
    [customerId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`customer ${customerId} not found in ${table}`);
  }
  return row.full_name;
}

/**
 * THE DANGEROUS MIGRATION: `ALTER TABLE ... RENAME COLUMN full_name TO
 * display_name`, run while old application code (still expecting
 * `full_name`) is live - the real production-incident shape this lab opens
 * with. A rolling deploy briefly runs OLD and NEW application instances side
 * by side; if the database migration finishes before every instance has been
 * redeployed onto code that reads `display_name`, every remaining old
 * instance's query breaks the instant the rename commits. There is no
 * gradual degradation - it is a hard, immediate SQL error on every request
 * that touches this column.
 *
 * This demo runs against `customers_naive_demo`, a throwaway, non-Drizzle-
 * tracked COPY of `customers` created fresh by this function - NOT the real
 * `customers` table the rest of this lab's scenarios, seed, and tests share.
 * That isolation exists purely so this lab's other scenarios stay repeatable
 * (this script can be rerun any number of times without disturbing anyone
 * else's state); in a real incident there is of course no "scratch copy" -
 * this IS the production table, and the rename really does commit.
 */
export async function runNaiveRenameIncident(
  connectionString: string,
  customerId?: number,
): Promise<NaiveRenameIncidentResult> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query("DROP TABLE IF EXISTS customers_naive_demo");
    await client.query(
      "CREATE TABLE customers_naive_demo AS SELECT id, public_id, full_name FROM customers",
    );

    const targetId =
      customerId ??
      (await client.query<{ id: number }>("SELECT id FROM customers_naive_demo ORDER BY id LIMIT 1"))
        .rows[0]?.id;
    if (targetId === undefined) {
      throw new Error("customers_naive_demo is empty - run `pnpm seed` first");
    }

    const oldCodeValueBeforeRename = await oldCodeReadFullName(client, "customers_naive_demo", targetId);
    log.info(
      { customerId: targetId, fullName: oldCodeValueBeforeRename },
      "old application code: SELECT full_name succeeds before the migration runs",
    );

    // THE MIGRATION. A single, ordinary DDL statement, run to completion and
    // committed (Postgres autocommits a bare statement outside an explicit
    // transaction) - exactly what a migration tool executing "rename this
    // column" would do. From this line onward, every session in the cluster
    // - including old application instances that have not been redeployed -
    // sees a table with no `full_name` column at all.
    await client.query("ALTER TABLE customers_naive_demo RENAME COLUMN full_name TO display_name");
    log.warn(
      { customerId: targetId },
      "MIGRATION COMMITTED: full_name renamed to display_name - old application instances have NOT been redeployed yet",
    );

    let oldCodeErrorCode: string | undefined;
    let oldCodeErrorMessage: string | undefined;
    try {
      await oldCodeReadFullName(client, "customers_naive_demo", targetId);
      log.error("unexpected: old code's query against full_name succeeded after the rename - incident did not reproduce");
    } catch (error) {
      const pgError = error as { code?: string; message: string };
      oldCodeErrorCode = pgError.code;
      oldCodeErrorMessage = pgError.message;
      log.error(
        { customerId: targetId, sqlState: pgError.code, err: error },
        "INCIDENT: old application code's query failed the instant the rename committed",
      );
    }

    const newCodeResult = await client.query<{ display_name: string }>(
      "SELECT display_name FROM customers_naive_demo WHERE id = $1",
      [targetId],
    );
    const newCodeValueAfterRename = newCodeResult.rows[0]?.display_name;
    log.info(
      { customerId: targetId, displayName: newCodeValueAfterRename },
      "new application code (reading display_name) would have worked fine all along - it just hasn't been deployed everywhere yet",
    );

    return {
      customerId: targetId,
      oldCodeValueBeforeRename,
      oldCodeErrorCode,
      oldCodeErrorMessage,
      newCodeValueAfterRename,
    };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }

  log.info("--- naive migration: RENAME COLUMN while old application code is still running ---");
  const result = await runNaiveRenameIncident(process.env.DATABASE_URL);

  log.info(
    {
      ...result,
      incidentReproduced: result.oldCodeErrorCode === "42703",
    },
    result.oldCodeErrorCode === "42703"
      ? "confirmed: this is a real, reproduced production incident, not a hypothetical"
      : "unexpected: incident did not reproduce",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "naive-rename scenario failed");
    process.exit(1);
  });
}
