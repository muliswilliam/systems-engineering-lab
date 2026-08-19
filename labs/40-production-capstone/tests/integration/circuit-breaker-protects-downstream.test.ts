import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { NotificationService } from "../../src/downstream/notification-service.js";
import { createProtectedWorker } from "../../src/outbox/worker-protected.js";

let insertedIds: number[] = [];

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterEach(async () => {
  if (insertedIds.length > 0) {
    await pool.query("DELETE FROM notification_attempts WHERE order_public_id = ANY(SELECT (payload->>'orderPublicId')::uuid FROM outbox_events WHERE id = ANY($1))", [insertedIds]);
    await pool.query("DELETE FROM outbox_events WHERE id = ANY($1)", [insertedIds]);
    insertedIds = [];
  }
});

afterAll(async () => {
  await pool.end();
});

async function insertPendingEvents(count: number, maxAttempts: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO outbox_events (event_type, payload, max_attempts) VALUES ('OrderConfirmed', $1, $2) RETURNING id`,
      [
        JSON.stringify({ orderPublicId: randomUUID(), correlationId: `breaker-${i}`, customerEmail: "x@example.com", amountCents: 100 }),
        maxAttempts,
      ],
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

describe("circuit breaker protects a struggling downstream from pile-up (Lab 37's mechanism, reused fresh, composed with SKIP LOCKED claiming)", () => {
  it("once tripped, the breaker rejects further claims WITHOUT calling the downstream, bounding total calls regardless of queue depth", async () => {
    const EVENT_COUNT = 6;
    const ids = await insertPendingEvents(EVENT_COUNT, 1);
    insertedIds = ids;

    const notificationService = new NotificationService({ seed: 1, health: "down" });
    const worker = createProtectedWorker({
      failureThreshold: 2,
      cooldownMs: 10_000, // long enough that this test never observes a HALF_OPEN recovery
      timeoutMs: 100,
      maxAttempts: 2,
      baseDelayMs: 5,
      maxDelayMs: 20,
    });

    const stats = await worker.runProtectedWorker(pool, "breaker-test-worker", notificationService, {
      maxEmptyPolls: 3,
    });

    // 2 events each get 2 real downstream calls before the breaker trips
    // (consecutiveFailures reaches failureThreshold=2 after the SECOND
    // event's execute() call fails) - every event after that is rejected
    // LOCALLY, at zero cost to the downstream.
    expect(notificationService.totalCallCount).toBe(4);
    expect(stats.notificationCallsMade).toBe(4);
    expect(stats.circuitOpenRejections).toBe(EVENT_COUNT - 2);
    expect(stats.failed).toBe(EVENT_COUNT);
    expect(stats.published).toBe(0);
    expect(worker.getBreakerState()).toBe("OPEN");

    const { rows } = await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*) FROM outbox_events WHERE id = ANY($1) GROUP BY status`,
      [ids],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
  });
});
