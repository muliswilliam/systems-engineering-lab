import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_COMPANIES } from "../seed/scenario-companies.js";
import { advisoryXactLock, connectClient, findCompanyByName, tryAdvisoryXactLock } from "./support.js";

const log = createLogger("lab13:scenario:xact-lock-auto-release");

const COMPANY_NAME = SCENARIO_COMPANIES[0].name;

export interface XactLockAutoReleaseResult {
  companyId: number;
  acquiredWhileOpenCommitCase: boolean;
  acquiredImmediatelyAfterCommit: boolean;
  acquiredWhileOpenRollbackCase: boolean;
  acquiredImmediatelyAfterRollback: boolean;
}

/**
 * `pg_advisory_xact_lock` has no unlock function - PostgreSQL releases it
 * automatically when the holding transaction ends, whether that's COMMIT or
 * ROLLBACK. This runs the same "holder opens a transaction, takes the lock,
 * a second session tries the same key" interleaving twice: once ending in
 * COMMIT, once ending in ROLLBACK, proving both release the lock without any
 * explicit unlock call ever being made.
 *
 * The checker's `pg_try_advisory_xact_lock` calls run without an explicit
 * `BEGIN`, so each one is its own single-statement, auto-committed
 * transaction: it acquires (or fails to acquire) the lock, and if it
 * acquired it, releases it again immediately when that implicit transaction
 * ends. That's fine here - each call is only used as an instantaneous probe
 * of "is this key free right now", which is exactly what the boolean result
 * reports.
 */
export async function runXactLockAutoRelease(connectionString: string): Promise<XactLockAutoReleaseResult> {
  const company = await findCompanyByName(connectionString, COMPANY_NAME);

  // --- COMMIT case ---
  const holderCommit = await connectClient(connectionString);
  const checkerCommit = await connectClient(connectionString);
  let acquiredWhileOpenCommitCase: boolean;
  let acquiredImmediatelyAfterCommit: boolean;
  try {
    await holderCommit.query("BEGIN");
    await advisoryXactLock(holderCommit, company.id);
    log.info({ companyId: company.id }, "holder (COMMIT case): BEGIN + pg_advisory_xact_lock acquired");

    acquiredWhileOpenCommitCase = await tryAdvisoryXactLock(checkerCommit, company.id);
    log.info(
      { companyId: company.id, acquired: acquiredWhileOpenCommitCase },
      "checker: pg_try_advisory_xact_lock while holder's transaction is still open",
    );

    await holderCommit.query("COMMIT");
    log.info({ companyId: company.id }, "holder (COMMIT case): COMMIT - no explicit unlock call was ever made");

    acquiredImmediatelyAfterCommit = await tryAdvisoryXactLock(checkerCommit, company.id);
    log.info(
      { companyId: company.id, acquired: acquiredImmediatelyAfterCommit },
      "checker: pg_try_advisory_xact_lock immediately after holder's COMMIT",
    );
  } finally {
    await holderCommit.end();
    await checkerCommit.end();
  }

  // --- ROLLBACK case ---
  const holderRollback = await connectClient(connectionString);
  const checkerRollback = await connectClient(connectionString);
  let acquiredWhileOpenRollbackCase: boolean;
  let acquiredImmediatelyAfterRollback: boolean;
  try {
    await holderRollback.query("BEGIN");
    await advisoryXactLock(holderRollback, company.id);
    log.info({ companyId: company.id }, "holder (ROLLBACK case): BEGIN + pg_advisory_xact_lock acquired");

    acquiredWhileOpenRollbackCase = await tryAdvisoryXactLock(checkerRollback, company.id);
    log.info(
      { companyId: company.id, acquired: acquiredWhileOpenRollbackCase },
      "checker: pg_try_advisory_xact_lock while holder's transaction is still open",
    );

    await holderRollback.query("ROLLBACK");
    log.info(
      { companyId: company.id },
      "holder (ROLLBACK case): ROLLBACK - no explicit unlock call was ever made",
    );

    acquiredImmediatelyAfterRollback = await tryAdvisoryXactLock(checkerRollback, company.id);
    log.info(
      { companyId: company.id, acquired: acquiredImmediatelyAfterRollback },
      "checker: pg_try_advisory_xact_lock immediately after holder's ROLLBACK",
    );
  } finally {
    await holderRollback.end();
    await checkerRollback.end();
  }

  return {
    companyId: company.id,
    acquiredWhileOpenCommitCase,
    acquiredImmediatelyAfterCommit,
    acquiredWhileOpenRollbackCase,
    acquiredImmediatelyAfterRollback,
  };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const result = await runXactLockAutoRelease(connectionString);
  log.warn({ ...result }, "xact-lock-auto-release scenario complete");
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "xact-lock-auto-release scenario failed");
    process.exit(1);
  });
}
