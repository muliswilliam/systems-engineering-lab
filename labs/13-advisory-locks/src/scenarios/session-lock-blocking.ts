import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_COMPANIES } from "../seed/scenario-companies.js";
import { advisoryLock, advisoryUnlock, connectClient, findCompanyByName, sleep, tryAdvisoryLock } from "./support.js";

const log = createLogger("lab13:scenario:session-lock-blocking");

const COMPANY_A_NAME = SCENARIO_COMPANIES[0].name;
const COMPANY_B_NAME = SCENARIO_COMPANIES[1].name;
const HOLD_MS = 800;

export interface SessionLockBlockingResult {
  companyAId: number;
  companyBId: number;
  workerBAcquiredWhileALocked: boolean;
  workerCAcquiredDifferentKeyImmediately: boolean;
  workerBRetryAfterReleaseAcquired: boolean;
  holdDurationMs: number;
}

/**
 * Worker A takes a blocking, session-level lock (`pg_advisory_lock`) on
 * company A's numeric id and holds it for HOLD_MS to simulate "processing
 * payroll for company A". While A holds it:
 *
 * - Worker B tries a non-blocking lock (`pg_try_advisory_lock`) on the SAME
 *   key - this must return false, proving the key is genuinely contended.
 * - Worker C tries a non-blocking lock on company B's DIFFERENT key at the
 *   same moment - this must return true immediately, proving lock
 *   granularity is per numeric key, not one global lock.
 *
 * After A calls `pg_advisory_unlock`, B retries and must now succeed.
 */
export async function runSessionLockBlocking(connectionString: string): Promise<SessionLockBlockingResult> {
  const companyA = await findCompanyByName(connectionString, COMPANY_A_NAME);
  const companyB = await findCompanyByName(connectionString, COMPANY_B_NAME);

  const workerA = await connectClient(connectionString);
  const workerB = await connectClient(connectionString);
  const workerC = await connectClient(connectionString);

  try {
    const acquireStart = Date.now();
    log.info({ worker: "A", companyId: companyA.id }, "worker A: pg_advisory_lock (blocking) - acquiring");
    await advisoryLock(workerA, companyA.id);
    log.info(
      { worker: "A", companyId: companyA.id, tookMs: Date.now() - acquireStart },
      "worker A: lock acquired, holding while 'processing'",
    );

    const workerBAcquiredWhileALocked = await tryAdvisoryLock(workerB, companyA.id);
    log.info(
      { worker: "B", companyId: companyA.id, acquired: workerBAcquiredWhileALocked },
      "worker B: pg_try_advisory_lock on the SAME key while A still holds it",
    );

    const workerCAcquiredDifferentKeyImmediately = await tryAdvisoryLock(workerC, companyB.id);
    log.info(
      { worker: "C", companyId: companyB.id, acquired: workerCAcquiredDifferentKeyImmediately },
      "worker C: pg_try_advisory_lock on a DIFFERENT key, at the same moment A still holds company A's key",
    );
    if (workerCAcquiredDifferentKeyImmediately) {
      await advisoryUnlock(workerC, companyB.id);
    }

    await sleep(HOLD_MS);

    const released = await advisoryUnlock(workerA, companyA.id);
    log.info({ worker: "A", companyId: companyA.id, released }, "worker A: pg_advisory_unlock");

    const workerBRetryAfterReleaseAcquired = await tryAdvisoryLock(workerB, companyA.id);
    log.info(
      { worker: "B", companyId: companyA.id, acquired: workerBRetryAfterReleaseAcquired },
      "worker B: retried pg_try_advisory_lock after A released - the key is free again",
    );
    if (workerBRetryAfterReleaseAcquired) {
      await advisoryUnlock(workerB, companyA.id);
    }

    return {
      companyAId: companyA.id,
      companyBId: companyB.id,
      workerBAcquiredWhileALocked,
      workerCAcquiredDifferentKeyImmediately,
      workerBRetryAfterReleaseAcquired,
      holdDurationMs: HOLD_MS,
    };
  } finally {
    await workerA.end();
    await workerB.end();
    await workerC.end();
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const result = await runSessionLockBlocking(connectionString);
  log.warn({ ...result }, "session-lock-blocking scenario complete");
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "session-lock-blocking scenario failed");
    process.exit(1);
  });
}
