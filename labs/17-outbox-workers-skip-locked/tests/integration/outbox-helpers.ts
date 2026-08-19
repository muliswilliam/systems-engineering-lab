import { inArray } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { outboxEvents, processedEvents } from "../../src/db/schema.js";

/**
 * Each test constructs its own small, isolated batch of scratch outbox
 * events with known payloads - same rationale as Lab 05's account-helpers.ts:
 * concurrency/invariant assertions are far clearer against events a test
 * created itself than against rows shared with every other test in the
 * file.
 */
export async function insertPendingEvents(count: number, prefix: string) {
  const rows = Array.from({ length: count }, (_, i) => ({
    eventType: "OrderCreated",
    payload: { note: `${prefix}-${i}` },
    status: "pending" as const,
  }));
  return db.insert(outboxEvents).values(rows).returning();
}

export async function cleanupEvents(eventIds: number[], publicIds: string[]): Promise<void> {
  if (publicIds.length > 0) {
    await db.delete(processedEvents).where(inArray(processedEvents.eventPublicId, publicIds));
  }
  if (eventIds.length > 0) {
    await db.delete(outboxEvents).where(inArray(outboxEvents.id, eventIds));
  }
}
