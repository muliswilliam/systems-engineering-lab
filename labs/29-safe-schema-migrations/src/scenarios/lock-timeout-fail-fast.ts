import "dotenv/config";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createLogger } from "@labs/logging";
import { holdWriteLockingTransaction } from "./lock-helpers.js";

const log = createLogger("lab29:scenario:lock-timeout");

export interface DdlRaceResult {
  durationMs: number;
  succeeded: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * `ALTER TABLE ... ADD COLUMN` requires an ACCESS EXCLUSIVE lock on the
 * table, no matter how cheap the change is under the hood (see
 * expand-contract-migration.ts's phase (a): the column itself is added
 * instantly once the lock is held - ACCESS EXCLUSIVE conflicts with EVERY
 * other lock mode, including the ROW EXCLUSIVE lock held by an ordinary open
 * write transaction). If something else is already holding any conflicting
 * lock on the table, `ALTER TABLE` must wait for it - and by default it
 * waits indefinitely. Every OTHER statement against this table that starts
 * queuing up behind the pending ALTER TABLE also waits, even simple reads -
 * this is the real, common "migration looks hung" incident: it isn't hung,
 * it's queued, and it just became the front of a growing queue.
 */
async function attemptAlterTable(
  client: Client,
  columnName: string,
  lockTimeoutMs?: number,
): Promise<DdlRaceResult> {
  if (lockTimeoutMs !== undefined) {
    await client.query(`SET lock_timeout = '${lockTimeoutMs}ms'`);
  } else {
    await client.query("SET lock_timeout = 0"); // 0 = wait indefinitely (Postgres default)
  }

  const start = performance.now();
  try {
    await client.query(`ALTER TABLE customers ADD COLUMN ${columnName} text`);
    const durationMs = performance.now() - start;
    return { durationMs, succeeded: true };
  } catch (error) {
    const durationMs = performance.now() - start;
    const pgError = error as { code?: string; message: string };
    return {
      durationMs,
      succeeded: false,
      errorCode: pgError.code,
      errorMessage: pgError.message,
    };
  }
}

/**
 * RUN 1 - no lock_timeout: the migration DDL genuinely blocks for the full
 * duration of the held conflicting lock, then succeeds once it is released.
 */
export async function runAlterTableWithoutLockTimeout(
  connectionString: string,
  customerId: number,
  holdMs: number,
  columnName: string,
): Promise<DdlRaceResult> {
  const holderClient = new Client({ connectionString });
  const ddlClient = new Client({ connectionString });
  await holderClient.connect();
  await ddlClient.connect();

  try {
    await ddlClient.query(`ALTER TABLE customers DROP COLUMN IF EXISTS ${columnName}`);

    const holderDone = holdWriteLockingTransaction(holderClient, customerId, holdMs);
    await new Promise((resolve) => setTimeout(resolve, 50));

    log.info({ holdMs, columnName }, "issuing ALTER TABLE with NO lock_timeout against a locked table");
    const result = await attemptAlterTable(ddlClient, columnName);
    await holderDone;

    log.warn(result, "ALTER TABLE (no lock_timeout) blocked until the conflicting lock was released, then succeeded");

    // Cleanup so this is safe to rerun.
    await ddlClient.query(`ALTER TABLE customers DROP COLUMN IF EXISTS ${columnName}`);

    return result;
  } finally {
    await holderClient.end();
    await ddlClient.end();
  }
}

/**
 * RUN 2 - `SET lock_timeout` before the same DDL: the statement fails FAST,
 * with a real Postgres error (`canceling statement due to lock timeout`,
 * SQLSTATE 55P03), instead of joining the queue indefinitely. This is the
 * production-safe pattern: a migration tool that sets a short lock_timeout
 * either gets the lock quickly or gives up and lets the operator retry
 * during a quieter window - it never becomes the thing blocking every other
 * query on the table.
 */
export async function runAlterTableWithLockTimeout(
  connectionString: string,
  customerId: number,
  holdMs: number,
  lockTimeoutMs: number,
  columnName: string,
): Promise<DdlRaceResult> {
  const holderClient = new Client({ connectionString });
  const ddlClient = new Client({ connectionString });
  await holderClient.connect();
  await ddlClient.connect();

  try {
    await ddlClient.query(`ALTER TABLE customers DROP COLUMN IF EXISTS ${columnName}`);

    const holderDone = holdWriteLockingTransaction(holderClient, customerId, holdMs);
    await new Promise((resolve) => setTimeout(resolve, 50));

    log.info(
      { holdMs, lockTimeoutMs, columnName },
      "issuing ALTER TABLE with SET lock_timeout against the identical locked table",
    );
    const result = await attemptAlterTable(ddlClient, columnName, lockTimeoutMs);

    if (result.succeeded) {
      log.error(result, "unexpected: ALTER TABLE succeeded instead of failing fast on lock_timeout");
    } else {
      log.warn(
        result,
        "MIGRATION FAILED FAST: lock_timeout fired before the conflicting lock was released",
      );
    }

    await holderDone;
    await ddlClient.query(`ALTER TABLE customers DROP COLUMN IF EXISTS ${columnName}`);

    return result;
  } finally {
    await holderClient.end();
    await ddlClient.end();
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const connectionString = process.env.DATABASE_URL;

  const seedClient = new Client({ connectionString });
  await seedClient.connect();
  const idResult = await seedClient.query<{ id: number }>("SELECT id FROM customers ORDER BY id LIMIT 1");
  await seedClient.end();
  const customerId = idResult.rows[0]?.id;
  if (customerId === undefined) {
    throw new Error("Need at least 1 customer - run `pnpm seed` first");
  }

  const holdMs = 1_500;
  const lockTimeoutMs = 500;

  log.info("--- run 1: ALTER TABLE with NO lock_timeout - blocks for the full hold duration ---");
  const withoutTimeout = await runAlterTableWithoutLockTimeout(
    connectionString,
    customerId,
    holdMs,
    "demo_col_no_timeout",
  );

  log.info("--- run 2: ALTER TABLE with SET lock_timeout - fails fast instead of hanging ---");
  const withTimeout = await runAlterTableWithLockTimeout(
    connectionString,
    customerId,
    holdMs,
    lockTimeoutMs,
    "demo_col_with_timeout",
  );

  log.info(
    {
      holdMs,
      lockTimeoutMs,
      withoutLockTimeoutDurationMs: withoutTimeout.durationMs,
      withoutLockTimeoutSucceeded: withoutTimeout.succeeded,
      withLockTimeoutDurationMs: withTimeout.durationMs,
      withLockTimeoutErrorCode: withTimeout.errorCode,
    },
    "summary: same DDL, same conflicting lock - lock_timeout is the only difference between hanging and failing fast",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "lock-timeout scenario failed");
    process.exit(1);
  });
}
