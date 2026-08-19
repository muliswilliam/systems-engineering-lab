import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_COMPANIES } from "../seed/scenario-companies.js";
import {
  advisoryLock,
  advisoryUnlock,
  connectClient,
  findCompanyByName,
  readPayrollRun,
  resetPayrollRun,
} from "./support.js";

const log = createLogger("lab13:scenario:advisory-lock-does-not-protect-rows");

const COMPANY_NAME = SCENARIO_COMPANIES[0].name;

export interface RowProtectionResult {
  companyId: number;
  lockHeldByWorkerA: true;
  directUpdateRowCount: number;
  directUpdateSucceededWhileLockHeld: boolean;
  directUpdateDurationMs: number;
  finalStatus: string;
}

/**
 * THE demonstration CLAUDE.md's "Advisory Locks" section requires: advisory
 * locks coordinate cooperating application code, they do NOT put any lock on
 * a row. Worker A takes `pg_advisory_lock` on company A's key - representing
 * "I am the one process allowed to run this company's payroll right now" -
 * and holds it. A second, completely separate connection that never calls
 * any `pg_advisory_*` function at all (representing a buggy code path, an
 * ad-hoc `psql` session, or a second application that forgot to cooperate)
 * then issues a plain `UPDATE` against the exact row worker A believes it
 * owns. That `UPDATE` succeeds immediately - the advisory lock provided
 * exactly zero protection against a caller that did not choose to check it.
 */
export async function runAdvisoryLockDoesNotProtectRows(connectionString: string): Promise<RowProtectionResult> {
  const company = await findCompanyByName(connectionString, COMPANY_NAME);
  await resetPayrollRun(connectionString, company.id);

  const workerA = await connectClient(connectionString);
  const buggyConnection = await connectClient(connectionString);

  try {
    await advisoryLock(workerA, company.id);
    log.warn(
      { companyId: company.id },
      "worker A holds pg_advisory_lock for this company - believes it is the only writer 'processing payroll'",
    );

    const start = Date.now();
    const { rowCount } = await buggyConnection.query(
      `UPDATE payroll_runs
       SET status = 'corrupted-by-bypass',
           total_cents = total_cents + 999999,
           processed_by_worker = 'buggy-connection-that-never-called-pg_advisory_lock',
           updated_at = now()
       WHERE company_id = $1`,
      [company.id],
    );
    const directUpdateDurationMs = Date.now() - start;

    log.error(
      { companyId: company.id, rowCount, directUpdateDurationMs },
      "a connection that NEVER called pg_advisory_lock updated the SAME row anyway, instantly, while the lock was held",
    );

    const after = await readPayrollRun(connectionString, company.id);

    const released = await advisoryUnlock(workerA, company.id);
    log.info({ companyId: company.id, released }, "worker A: pg_advisory_unlock (too late to matter)");

    return {
      companyId: company.id,
      lockHeldByWorkerA: true,
      directUpdateRowCount: rowCount ?? 0,
      directUpdateSucceededWhileLockHeld: (rowCount ?? 0) === 1,
      directUpdateDurationMs,
      finalStatus: after.status,
    };
  } finally {
    await workerA.end();
    await buggyConnection.end();
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const result = await runAdvisoryLockDoesNotProtectRows(connectionString);
  log.warn(
    { ...result },
    "advisory-lock-does-not-protect-rows scenario complete - the lock protected nothing on its own",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "advisory-lock-does-not-protect-rows scenario failed");
    process.exit(1);
  });
}
