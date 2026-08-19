import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { SCENARIO_COMPANIES } from "../seed/scenario-companies.js";
import { advisoryLock, advisoryUnlock, connectClient, findCompanyByName, sleep, tryAdvisoryLock } from "./support.js";

const log = createLogger("lab13:scenario:connection-loss");

const COMPANY_NAME = SCENARIO_COMPANIES[0].name;
// Give Postgres a moment to notice the closed TCP connection and clean up
// the backend's session state (including its advisory locks) before the
// second check - this is not "waiting for the lock", it's waiting for
// connection teardown, which is near-instant locally but not synchronous
// with the client-side `.end()` call returning.
const POST_DISCONNECT_SETTLE_MS = 300;

export interface ConnectionLossResult {
  companyId: number;
  workerBAcquiredWhileAHeldOpen: boolean;
  workerBAcquiredAfterConnectionClosed: boolean;
}

/**
 * Worker A takes a session-level lock (`pg_advisory_lock`) and then its
 * connection is closed (`client.end()`) WITHOUT ever calling
 * `pg_advisory_unlock` - simulating a worker process crashing while holding
 * the lock. Session-level advisory locks are tied to the Postgres backend
 * process for the connection that took them, not to any explicit release
 * call, so Postgres releases them the moment that backend process exits.
 * Worker B proves this by successfully acquiring the same key right after.
 */
export async function runConnectionLossReleasesLock(connectionString: string): Promise<ConnectionLossResult> {
  const company = await findCompanyByName(connectionString, COMPANY_NAME);

  const workerA = await connectClient(connectionString);
  const workerB = await connectClient(connectionString);

  try {
    await advisoryLock(workerA, company.id);
    log.info({ companyId: company.id }, "worker A: pg_advisory_lock acquired - will 'crash' without unlocking");

    const workerBAcquiredWhileAHeldOpen = await tryAdvisoryLock(workerB, company.id);
    log.info(
      { companyId: company.id, acquired: workerBAcquiredWhileAHeldOpen },
      "worker B: pg_try_advisory_lock while A's connection is still open",
    );

    await workerA.end();
    log.warn(
      { companyId: company.id },
      "worker A: connection closed via client.end() - pg_advisory_unlock was NEVER called",
    );

    await sleep(POST_DISCONNECT_SETTLE_MS);

    const workerBAcquiredAfterConnectionClosed = await tryAdvisoryLock(workerB, company.id);
    log.info(
      { companyId: company.id, acquired: workerBAcquiredAfterConnectionClosed },
      "worker B: pg_try_advisory_lock again, after A's connection closed",
    );
    if (workerBAcquiredAfterConnectionClosed) {
      await advisoryUnlock(workerB, company.id);
    }

    return { companyId: company.id, workerBAcquiredWhileAHeldOpen, workerBAcquiredAfterConnectionClosed };
  } finally {
    await workerB.end();
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const result = await runConnectionLossReleasesLock(connectionString);
  log.warn({ ...result }, "connection-loss-releases-lock scenario complete");
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "connection-loss-releases-lock scenario failed");
    process.exit(1);
  });
}
