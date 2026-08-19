import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { outboxEvents, processedEvents } from "../../src/db/schema.js";
import { runCrashedPublisherDemo } from "../../src/scenarios/crashed-publisher-duplicate-delivery.js";
import { createSimulatedBroker } from "../../src/queue/broker.js";
import { cleanupEvents, insertPendingEvents } from "./outbox-helpers.js";

let currentEventId: number | undefined;

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.delete(processedEvents);
  await db.delete(outboxEvents);
});

afterEach(async () => {
  if (currentEventId !== undefined) {
    await cleanupEvents([currentEventId], []);
    currentEventId = undefined;
  }
});

afterAll(async () => {
  await pool.end();
});

/**
 * This file proves the limitation is real, not just narrated in the README -
 * per CLAUDE.md's "Transactional Outbox" section: "Do not imply that the
 * outbox magically prevents duplicate publication."
 */
describe("crashed publisher: SKIP LOCKED protects the claim, not the delivery", () => {
  it("publishToBroker is genuinely called MORE THAN ONCE for the same event, even though the claim was never held by two workers at once", async () => {
    const [event] = await insertPendingEvents(1, "crash-demo");
    currentEventId = event!.id;

    const broker = createSimulatedBroker({ mode: "succeed" });
    const LEASE_MS = 300;

    const result = await runCrashedPublisherDemo(pool, broker, LEASE_MS);

    expect(result.eventId).toBe(event!.id);

    // THE central assertion of this lab: the broker really was invoked twice
    // for this one logical event.
    expect(result.brokerCallCount).toBe(2);
    expect(broker.deliveries.filter((d) => d.publicId === result.eventPublicId)).toHaveLength(2);

    // The claim/lock invariant still held: each claim incremented `attempts`
    // by exactly 1, sequentially (1, then 2) - there is no scenario where
    // both workers held `status='processing'` on this row with unexpired
    // leases at the same time, because worker B's claim query can only ever
    // see this row once `locked_until` is provably in the past.
    expect(result.workerAAttempt).toBe(1);
    expect(result.workerBAttempt).toBe(2);
    expect(result.finalAttempts).toBe(2);

    // The row DID eventually reach a correct terminal state once a worker
    // finished the full claim -> publish -> finalize sequence without
    // crashing.
    expect(result.finalStatus).toBe("published");

    const row = await db.select().from(outboxEvents).where(eq(outboxEvents.id, event!.id));
    expect(row[0]!.status).toBe("published");
    expect(row[0]!.attempts).toBe(2);
  });
});
