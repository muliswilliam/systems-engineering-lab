import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { claimAndPublish, claimNextEvent, markPublished } from "../queue/claim-and-publish.js";
import { createSimulatedBroker, type SimulatedBroker } from "../queue/broker.js";

const log = createLogger("lab17:scenario:crashed-publisher");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CrashedPublisherResult {
  eventId: number;
  eventPublicId: string;
  /** How many times `publishToBroker` was actually invoked for this event's
   * public_id. THE key number this scenario exists to produce - it is 2,
   * proving SKIP LOCKED's safe claim does not make delivery exactly-once. */
  brokerCallCount: number;
  workerAAttempt: number;
  workerBAttempt: number;
  finalStatus: string;
  finalAttempts: number;
}

/**
 * THE KEY DEMONSTRATION (README "Break it").
 *
 * 1. Worker A claims the event (transaction commits: status='processing',
 *    locked_until = now() + leaseMs). The claim itself is safe - SKIP LOCKED
 *    guarantees no other worker could have claimed this same row at the same
 *    time.
 * 2. Worker A calls the broker. It genuinely succeeds - the broker recorded
 *    the event and would go on to process it.
 * 3. Worker A then "crashes": `claimAndPublish` is called with
 *    `skipFinalize: true`, so the UPDATE that would set status='published'
 *    never runs. This is the ENTIRE bug - not a claiming bug, a "the process
 *    died between the broker call succeeding and us recording that fact"
 *    bug.
 * 4. We wait past the lease.
 * 5. Worker B's claim query now finds the same row again
 *    (status='processing' AND locked_until < now()), reclaims it (its own
 *    fresh transaction, its own SKIP LOCKED guarantee), and ALSO calls the
 *    broker - which also succeeds, and finalizes normally this time.
 *
 * The claim/lock invariant never broke: at no point did two workers hold the
 * claim simultaneously (worker B's claim query only ever finds the row after
 * worker A's lease has provably expired). What broke is a DIFFERENT
 * invariant - "the broker is called at most once per event" - and nothing
 * about SKIP LOCKED, or about locking in general, protects that one. See
 * idempotent-consumer-preview.ts for what actually fixes it.
 */
export async function runCrashedPublisherDemo(
  pool: Pool,
  broker: SimulatedBroker,
  leaseMs: number,
): Promise<CrashedPublisherResult> {
  const workerA = "worker-crash-a";
  const workerB = "worker-crash-b";

  const resultA = await claimAndPublish(pool, broker, workerA, { leaseMs, skipFinalize: true });
  if (!resultA.claimed) {
    throw new Error("no claimable event - seed a pending outbox_events row first");
  }
  log.warn(
    { workerId: workerA, eventId: resultA.event.id, publicId: resultA.event.publicId },
    "worker A published successfully, then simulated a crash before finalizing",
  );

  // Wait past the lease so the row becomes reclaimable - this is not a
  // "sleep to avoid a race," it is the mechanism itself: only a genuinely
  // expired lease makes the row visible to the claim query again.
  await sleep(leaseMs + 150);

  const claimB = await claimNextEvent(pool, workerB, leaseMs);
  if (!claimB || claimB.id !== resultA.event.id) {
    throw new Error("expected worker B to reclaim the exact event worker A crashed on");
  }

  await broker.publish({ publicId: claimB.publicId, eventType: claimB.eventType, payload: claimB.payload });
  await markPublished(pool, claimB.id, workerB);
  log.info(
    { workerId: workerB, eventId: claimB.id, publicId: claimB.publicId, attempt: claimB.attempts },
    "worker B reclaimed the lease-expired event and published it (again)",
  );

  const finalRow = await pool.query<{ status: string; attempts: number }>(
    "SELECT status, attempts FROM outbox_events WHERE id = $1",
    [resultA.event.id],
  );
  const final = finalRow.rows[0]!;

  return {
    eventId: resultA.event.id,
    eventPublicId: resultA.event.publicId,
    brokerCallCount: broker.callCountFor(resultA.event.publicId),
    workerAAttempt: resultA.event.attempts,
    workerBAttempt: claimB.attempts,
    finalStatus: final.status,
    finalAttempts: final.attempts,
  };
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const pendingCountBefore = await pool.query<{ count: string }>(
    "SELECT count(*)::text FROM outbox_events WHERE status = 'pending'",
  );
  if (Number(pendingCountBefore.rows[0]?.count ?? 0) === 0) {
    log.warn("no pending outbox_events - run `pnpm seed` first");
    await pool.end();
    return;
  }

  const LEASE_MS = 500;
  const broker = createSimulatedBroker({ mode: "succeed" });

  const result = await runCrashedPublisherDemo(pool, broker, LEASE_MS);

  log.warn(
    result,
    result.brokerCallCount > 1
      ? "DUPLICATE DELIVERY CONFIRMED: publishToBroker was called more than once for the same event, even though the claim was never held by two workers at once"
      : "unexpected: broker was only called once - the crash did not reproduce",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "crashed-publisher scenario failed");
    process.exit(1);
  });
}
