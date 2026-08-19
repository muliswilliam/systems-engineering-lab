import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { outboxEvents, processedEvents } from "../../src/db/schema.js";
import { runIdempotentConsumerPreview } from "../../src/scenarios/idempotent-consumer-preview.js";
import { createSimulatedBroker } from "../../src/queue/broker.js";
import { cleanupEvents, insertPendingEvents } from "./outbox-helpers.js";

let currentEventId: number | undefined;
let currentPublicId: string | undefined;

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.delete(processedEvents);
  await db.delete(outboxEvents);
});

afterEach(async () => {
  if (currentEventId !== undefined) {
    await cleanupEvents([currentEventId], currentPublicId ? [currentPublicId] : []);
    currentEventId = undefined;
    currentPublicId = undefined;
  }
});

afterAll(async () => {
  await pool.end();
});

describe("idempotent-consumer-preview: the SAME crashed-publisher interleaving, with a dedup check", () => {
  it("applies the side effect exactly once despite the broker being called twice", async () => {
    const [event] = await insertPendingEvents(1, "idempotent-preview");
    currentEventId = event!.id;
    currentPublicId = event!.publicId;

    const broker = createSimulatedBroker({ mode: "succeed" });
    const LEASE_MS = 300;

    const result = await runIdempotentConsumerPreview(pool, broker, LEASE_MS);

    expect(result.eventPublicId).toBe(event!.publicId);

    // The duplicate delivery still genuinely happens at the broker level -
    // this preview does not (and cannot) prevent that; only the outbox's own
    // producer-side mechanics changed nothing about it.
    expect(result.brokerCallCount).toBe(2);

    // But the CONSUMER'S side effect - the thing that actually matters to
    // the business (charging a card, sending an email, adjusting inventory)
    // - ran exactly once, because the second `consumeIdempotently` call
    // found its `public_id` already recorded in `processed_events` and
    // skipped it.
    expect(result.sideEffectApplications).toBe(1);
    expect(result.finalStatus).toBe("published");

    const processedRows = await db
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.eventPublicId, event!.publicId));
    // Exactly one row - the UNIQUE constraint plus ON CONFLICT DO NOTHING
    // means the second INSERT attempt never created a second row, it just
    // silently did nothing (per CLAUDE.md's "prefer datastore-native
    // guarantees" over an application-level check-then-insert).
    expect(processedRows).toHaveLength(1);
  });
});
