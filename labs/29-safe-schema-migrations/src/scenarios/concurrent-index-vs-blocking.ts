import "dotenv/config";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createLogger } from "@labs/logging";
import { holdWriteLockingTransaction } from "./lock-helpers.js";

const log = createLogger("lab29:scenario:concurrent-index");

export interface PlainIndexRaceResult {
  /** Wall-clock ms from issuing CREATE INDEX to it returning. */
  createIndexDurationMs: number;
  /** Wall-clock ms the blocking transaction was held open for. */
  holdMs: number;
}

/**
 * RACE 1: a plain `CREATE INDEX` against a table a long-running transaction
 * has already written to.
 *
 * `CREATE INDEX` needs a SHARE lock on the table. SHARE conflicts with the
 * ROW EXCLUSIVE lock the held transaction's UPDATE already took - so
 * `CREATE INDEX` cannot even start building until that transaction commits
 * or rolls back. Every OTHER write against this table queues up behind
 * `CREATE INDEX` for the same reason, once it's waiting - this is why a
 * plain `CREATE INDEX` on a busy production table is dangerous, not just
 * slow.
 */
export async function raceCreateIndexPlain(
  connectionString: string,
  customerId: number,
  holdMs: number,
): Promise<PlainIndexRaceResult> {
  const holderClient = new Client({ connectionString });
  const indexClient = new Client({ connectionString });
  await holderClient.connect();
  await indexClient.connect();

  try {
    await indexClient.query("DROP INDEX IF EXISTS idx_customers_country_plain");

    const holderDone = holdWriteLockingTransaction(holderClient, customerId, holdMs);

    // Give the holder a moment to actually acquire its lock before we race
    // against it - otherwise this script could win the race trivially.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const start = performance.now();
    log.info({ customerId, holdMs }, "issuing plain CREATE INDEX while a write-holding transaction is open");
    await indexClient.query("CREATE INDEX idx_customers_country_plain ON customers (country)");
    const createIndexDurationMs = performance.now() - start;

    await holderDone;

    log.warn(
      { createIndexDurationMs, holdMs },
      "plain CREATE INDEX returned only after the blocking transaction committed",
    );

    return { createIndexDurationMs, holdMs };
  } finally {
    await holderClient.end();
    await indexClient.end();
  }
}

export interface ConcurrentIndexRaceResult {
  /** Wall-clock ms from issuing CREATE INDEX CONCURRENTLY to it returning. */
  createIndexConcurrentlyDurationMs: number;
  /** Wall-clock ms a THIRD, unrelated write took while both the holder
   * transaction and the concurrent index build were in flight. */
  thirdWriteDurationMs: number;
  holdMs: number;
}

/**
 * RACE 2: `CREATE INDEX CONCURRENTLY` against the identical setup.
 *
 * `CREATE INDEX CONCURRENTLY` takes a SHARE UPDATE EXCLUSIVE lock instead of
 * SHARE - which does NOT conflict with ROW EXCLUSIVE. It can start
 * immediately even while the holder transaction's write is in flight, and
 * ordinary writes from OTHER sessions are never blocked by it either. The
 * cost: it takes longer overall (two full table scans plus waiting for
 * concurrent transactions to finish, so it never has to lock out writers)
 * and, if it fails partway through, it can leave behind an INVALID index
 * that must be dropped and rebuilt by hand - Postgres does not retry it
 * for you.
 */
export async function raceCreateIndexConcurrently(
  connectionString: string,
  customerId: number,
  thirdWriteCustomerId: number,
  holdMs: number,
): Promise<ConcurrentIndexRaceResult> {
  const holderClient = new Client({ connectionString });
  const indexClient = new Client({ connectionString });
  const thirdWriterClient = new Client({ connectionString });
  await holderClient.connect();
  await indexClient.connect();
  await thirdWriterClient.connect();

  try {
    await indexClient.query("DROP INDEX IF EXISTS idx_customers_country_concurrent");

    const holderDone = holdWriteLockingTransaction(holderClient, customerId, holdMs);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const indexStart = performance.now();
    log.info(
      { customerId, holdMs },
      "issuing CREATE INDEX CONCURRENTLY while the same write-holding transaction is open",
    );
    const createIndexPromise = indexClient
      .query("CREATE INDEX CONCURRENTLY idx_customers_country_concurrent ON customers (country)")
      .then(() => performance.now() - indexStart);

    // While BOTH the holder transaction and the concurrent index build are
    // in flight, a completely unrelated write against a different row must
    // succeed quickly - this is the property a plain CREATE INDEX does not
    // have.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const thirdWriteStart = performance.now();
    await thirdWriterClient.query("UPDATE customers SET country = country WHERE id = $1", [
      thirdWriteCustomerId,
    ]);
    const thirdWriteDurationMs = performance.now() - thirdWriteStart;
    log.info(
      { thirdWriteCustomerId, thirdWriteDurationMs },
      "third-party write against an unrelated row succeeded WHILE CREATE INDEX CONCURRENTLY was still building",
    );

    const createIndexConcurrentlyDurationMs = await createIndexPromise;
    await holderDone;

    log.info(
      { createIndexConcurrentlyDurationMs, thirdWriteDurationMs, holdMs },
      "CREATE INDEX CONCURRENTLY finished without ever blocking ordinary writes",
    );

    return { createIndexConcurrentlyDurationMs, thirdWriteDurationMs, holdMs };
  } finally {
    await holderClient.end();
    await indexClient.end();
    await thirdWriterClient.end();
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const connectionString = process.env.DATABASE_URL;

  const seedClient = new Client({ connectionString });
  await seedClient.connect();
  const idsResult = await seedClient.query<{ id: number }>("SELECT id FROM customers ORDER BY id LIMIT 2");
  await seedClient.end();
  const [row1, row2] = idsResult.rows;
  if (!row1 || !row2) {
    throw new Error("Need at least 2 customers - run `pnpm seed` first");
  }

  const holdMs = 2_000;

  log.info("--- race 1: plain CREATE INDEX vs. a held write-locking transaction ---");
  const plainResult = await raceCreateIndexPlain(connectionString, row1.id, holdMs);

  log.info("--- race 2: CREATE INDEX CONCURRENTLY vs. the identical held transaction ---");
  const concurrentResult = await raceCreateIndexConcurrently(connectionString, row1.id, row2.id, holdMs);

  log.info(
    {
      plainCreateIndexDurationMs: plainResult.createIndexDurationMs,
      concurrentIndexBuildDurationMs: concurrentResult.createIndexConcurrentlyDurationMs,
      concurrentThirdWriteDurationMs: concurrentResult.thirdWriteDurationMs,
      holdMs,
    },
    "summary: plain CREATE INDEX blocked for the full hold duration; CONCURRENTLY let an unrelated write through almost immediately",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "concurrent-index scenario failed");
    process.exit(1);
  });
}
