import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { claimAndPublish, claimNextEvent, markPublished } from "../queue/claim-and-publish.js";
import { createSimulatedBroker, type SimulatedBroker, type BrokerEvent } from "../queue/broker.js";
import { consumeIdempotently } from "../queue/idempotent-consumer.js";

const log = createLogger("lab17:scenario:idempotent-preview");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface IdempotentPreviewResult {
  eventPublicId: string;
  brokerCallCount: number;
  /** How many times the CONSUMER actually applied its side effect - this is
   * the number the preview exists to keep at 1, despite the broker call
   * count above being 2. */
  sideEffectApplications: number;
  finalStatus: string;
}

/**
 * PREVIEW of Lab 18 - see src/queue/idempotent-consumer.ts for exactly what
 * is (and is not) implemented here. Replays the IDENTICAL crashed-publisher
 * interleaving as crashed-publisher-duplicate-delivery.ts - same claim, same
 * simulated crash, same reclaim, same two broker calls - but this time each
 * broker call is followed by `consumeIdempotently`, which only lets the
 * SECOND of the two calls' side effects be skipped.
 */
export async function runIdempotentConsumerPreview(
  pool: Pool,
  broker: SimulatedBroker,
  leaseMs: number,
): Promise<IdempotentPreviewResult> {
  const workerA = "worker-preview-a";
  const workerB = "worker-preview-b";
  const appliedSideEffects: BrokerEvent[] = [];
  const applySideEffect = (event: BrokerEvent) => {
    appliedSideEffects.push(event);
  };

  const resultA = await claimAndPublish(pool, broker, workerA, { leaseMs, skipFinalize: true });
  if (!resultA.claimed) {
    throw new Error("no claimable event - seed a pending outbox_events row first");
  }
  const eventA: BrokerEvent = {
    publicId: resultA.event.publicId,
    eventType: resultA.event.eventType,
    payload: resultA.event.payload,
  };
  const dedupA = await consumeIdempotently(pool, eventA, applySideEffect);
  log.warn(
    { workerId: workerA, publicId: eventA.publicId, duplicate: dedupA.duplicate },
    "worker A published successfully, applied the consumer side effect, then simulated a crash before finalizing",
  );

  await sleep(leaseMs + 150);

  const claimB = await claimNextEvent(pool, workerB, leaseMs);
  if (!claimB || claimB.id !== resultA.event.id) {
    throw new Error("expected worker B to reclaim the exact event worker A crashed on");
  }
  const eventB: BrokerEvent = { publicId: claimB.publicId, eventType: claimB.eventType, payload: claimB.payload };
  await broker.publish(eventB);
  await markPublished(pool, claimB.id, workerB);
  const dedupB = await consumeIdempotently(pool, eventB, applySideEffect);
  log.info(
    { workerId: workerB, publicId: eventB.publicId, duplicate: dedupB.duplicate },
    dedupB.duplicate
      ? "worker B reclaimed and published (again), but the consumer recognized the duplicate and skipped the side effect"
      : "unexpected: worker B's delivery was not recognized as a duplicate",
  );

  const finalRow = await pool.query<{ status: string }>("SELECT status FROM outbox_events WHERE id = $1", [
    resultA.event.id,
  ]);

  return {
    eventPublicId: eventA.publicId,
    brokerCallCount: broker.callCountFor(eventA.publicId),
    sideEffectApplications: appliedSideEffects.length,
    finalStatus: finalRow.rows[0]!.status,
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

  const result = await runIdempotentConsumerPreview(pool, broker, LEASE_MS);

  log.warn(
    result,
    result.brokerCallCount > 1 && result.sideEffectApplications === 1
      ? "HARMLESS DUPLICATE: publishToBroker was still called twice, but the idempotent consumer applied the side effect exactly once"
      : "unexpected: side effect count did not match the expected dedup behavior",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "idempotent-consumer-preview scenario failed");
    process.exit(1);
  });
}
