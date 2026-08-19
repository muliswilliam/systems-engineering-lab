import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { outboxEvents, processedEvents } from "../../src/db/schema.js";
import { drainWithWorkers } from "../../src/scenarios/parallel-publishers.js";
import { claimAndPublish, claimNextEvent, markPublished } from "../../src/queue/claim-and-publish.js";
import { createSimulatedBroker } from "../../src/queue/broker.js";
import { cleanupEvents, insertPendingEvents } from "./outbox-helpers.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  // The claim query is global across the whole table (that is the point of
  // this lab) - unlike Lab 05's scratch accounts, a leftover `pnpm seed`
  // dataset would be directly visible to this file's claim queries. Start
  // from a known-empty table so every assertion below is exact, regardless
  // of what a developer ran before `pnpm test`.
  await db.delete(processedEvents);
  await db.delete(outboxEvents);
});

afterAll(async () => {
  await pool.end();
});

describe("N concurrent publisher workers draining M outbox events", () => {
  it("every event is claimed by exactly one worker and the whole batch reaches published", async () => {
    const EVENT_COUNT = 50;
    const WORKER_COUNT = 10;
    const inserted = await insertPendingEvents(EVENT_COUNT, "parallel");
    const eventIds = inserted.map((e) => e.id);

    const broker = createSimulatedBroker({ mode: "succeed" });
    const result = await drainWithWorkers(pool, broker, WORKER_COUNT, 5_000);

    // The invariant this test exists to prove (SPEC.md section 11 / CLAUDE.md
    // "Transactions and Concurrency"): assert on final state and on the
    // no-double-claim invariant, never on which worker happened to finish
    // first.
    expect(result.totalClaimed).toBeGreaterThanOrEqual(EVENT_COUNT);

    const claimedOurs = result.claimedEventIds.filter((id) => eventIds.includes(id));
    expect(claimedOurs).toHaveLength(EVENT_COUNT);
    // No event ID appears twice in the claim log - the claim-window
    // invariant Lab 14 established, rebuilt independently here: with a fast
    // ("succeed") broker and a long lease, no lease ever expires mid-flight,
    // so every event is claimed exactly once, by exactly one worker.
    expect(new Set(claimedOurs).size).toBe(EVENT_COUNT);

    const rows = await db.select().from(outboxEvents).where(inArray(outboxEvents.id, eventIds));
    expect(rows).toHaveLength(EVENT_COUNT);
    for (const row of rows) {
      expect(row.status).toBe("published");
      expect(row.attempts).toBe(1);
    }

    // Every worker that claimed at least one event actually claimed a
    // distinct, disjoint set - summing per-worker counts reproduces the
    // total exactly.
    const perWorkerSum = Object.values(result.claimsByWorker).reduce((a, b) => a + b, 0);
    expect(perWorkerSum).toBe(result.totalClaimed);

    await cleanupEvents(eventIds, []);
  });

  it("a crashed publisher's event becomes reclaimable after its lease expires and eventually reaches published", async () => {
    const [event] = await insertPendingEvents(1, "lease-reclaim");
    const LEASE_MS = 300;
    const broker = createSimulatedBroker({ mode: "succeed" });

    // Worker A claims and publishes but "crashes" before finalizing - the
    // row is left at status='processing' with a short lease.
    const claimA = await claimAndPublish(pool, broker, "worker-lease-a", {
      leaseMs: LEASE_MS,
      skipFinalize: true,
    });
    expect(claimA.claimed).toBe(true);

    const midway = await db.select().from(outboxEvents).where(eq(outboxEvents.id, event!.id));
    expect(midway[0]!.status).toBe("processing");

    // Before the lease expires, a second worker's claim query must NOT see
    // this row - SKIP LOCKED plus the lease condition together mean an
    // unexpired 'processing' row is not yet claimable by anyone else.
    const tooEarly = await claimNextEvent(pool, "worker-lease-early", LEASE_MS);
    expect(tooEarly).toBeNull();

    // Wait past the lease.
    await new Promise((resolve) => setTimeout(resolve, LEASE_MS + 150));

    const claimB = await claimNextEvent(pool, "worker-lease-b", LEASE_MS);
    expect(claimB?.id).toBe(event!.id);
    expect(claimB?.attempts).toBe(2);

    await markPublished(pool, claimB!.id, "worker-lease-b");

    const finalRow = await db.select().from(outboxEvents).where(eq(outboxEvents.id, event!.id));
    expect(finalRow[0]!.status).toBe("published");
    expect(finalRow[0]!.attempts).toBe(2);

    await cleanupEvents([event!.id], []);
  });
});
