import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runConcurrently } from "@labs/test-utils";
import { claimAndPublish } from "../queue/claim-and-publish.js";
import { createSimulatedBroker, type SimulatedBroker } from "../queue/broker.js";

const log = createLogger("lab17:scenario:parallel-publishers");

export interface DrainResult {
  claimsByWorker: Record<string, number>;
  /** Every claimed event id, in claim order - used to assert no event is
   * ever claimed twice while the broker is fast (no lease expiry races). */
  claimedEventIds: number[];
  totalClaimed: number;
}

/**
 * Runs `workerCount` publisher workers CONCURRENTLY (real `Promise`s racing
 * against the same Postgres pool, not a sequential loop - CLAUDE.md
 * "Transactions and Concurrency": prefer multiple explicit workers over fake
 * sequential examples). Each worker loops `claimAndPublish` until it gets
 * `{ claimed: false }` back (no more claimable rows), then stops - workers
 * naturally drain unevenly, which is realistic and is exactly what gets
 * measured below.
 */
export async function drainWithWorkers(
  pool: Pool,
  broker: SimulatedBroker,
  workerCount: number,
  leaseMs: number,
): Promise<DrainResult> {
  const claimsByWorker: Record<string, number> = {};
  const claimedEventIds: number[] = [];

  await runConcurrently(workerCount, async (index) => {
    const workerId = `worker-${index}`;
    claimsByWorker[workerId] = 0;

    for (;;) {
      const result = await claimAndPublish(pool, broker, workerId, { leaseMs });
      if (!result.claimed) {
        break;
      }
      claimsByWorker[workerId] += 1;
      claimedEventIds.push(result.event.id);
    }
  });

  const totalClaimed = Object.values(claimsByWorker).reduce((sum, n) => sum + n, 0);
  return { claimsByWorker, claimedEventIds, totalClaimed };
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const pendingCountBefore = await pool.query<{ count: string }>(
    "SELECT count(*)::text FROM outbox_events WHERE status = 'pending'",
  );
  const pendingCount = Number(pendingCountBefore.rows[0]?.count ?? 0);
  if (pendingCount === 0) {
    log.warn("no pending outbox_events - run `pnpm seed` first");
    await pool.end();
    return;
  }

  const WORKER_COUNT = 10;
  const LEASE_MS = 5_000;
  const broker = createSimulatedBroker({ mode: "succeed" });

  log.info({ workerCount: WORKER_COUNT, pendingCount }, "starting parallel publisher drain");
  const startedAt = Date.now();
  const result = await drainWithWorkers(pool, broker, WORKER_COUNT, LEASE_MS);
  const wallClockMs = Date.now() - startedAt;

  const uniqueClaimed = new Set(result.claimedEventIds);
  const statusCounts = await pool.query<{ status: string; count: string }>(
    "SELECT status, count(*)::text FROM outbox_events GROUP BY status",
  );

  log.info(
    {
      workerCount: WORKER_COUNT,
      pendingCount,
      totalClaimed: result.totalClaimed,
      uniqueEventsClaimed: uniqueClaimed.size,
      noDoubleClaims: uniqueClaimed.size === result.claimedEventIds.length,
      claimsByWorker: result.claimsByWorker,
      wallClockMs,
      brokerTotalCalls: broker.totalCalls(),
      statusCounts: statusCounts.rows,
    },
    "parallel publisher drain complete",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "parallel-publishers scenario failed");
    process.exit(1);
  });
}
