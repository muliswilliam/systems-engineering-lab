import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { performTransactionalOrderCreation } from "../../src/scenarios/transactional-outbox.js";
import { drainOutbox } from "../../src/scripts/drain-outbox.js";
import type { BrokerEvent } from "../../src/scenarios/broker.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

async function getPublishedAt(outboxEventId: number): Promise<Date | null> {
  const result = await pool.query<{ published_at: Date | null }>(
    "SELECT published_at FROM outbox_events WHERE id = $1",
    [outboxEventId],
  );
  return result.rows[0]?.published_at ?? null;
}

describe("drain-outbox (minimal, one-shot preview of Lab 17's SKIP LOCKED publisher)", () => {
  it("publishes only published_at IS NULL events, marks them published, and never re-publishes on a second drain", async () => {
    const customerNameA = `Drain Test A - ${randomUUID()}`;
    const customerNameB = `Drain Test B - ${randomUUID()}`;

    const orderA = await performTransactionalOrderCreation(pool, {
      customerName: customerNameA,
      amountCents: 1_500,
      injectOutboxInsertFailure: false,
    });
    const orderB = await performTransactionalOrderCreation(pool, {
      customerName: customerNameB,
      amountCents: 2_500,
      injectOutboxInsertFailure: false,
    });
    expect(orderA.committed).toBe(true);
    expect(orderB.committed).toBe(true);
    if (!orderA.committed || !orderB.committed) throw new Error("setup failed");

    // Both outbox rows start unpublished.
    expect(await getPublishedAt(orderA.outboxEventId)).toBeNull();
    expect(await getPublishedAt(orderB.outboxEventId)).toBeNull();

    const publishCalls: BrokerEvent[] = [];
    const publish = async (event: BrokerEvent) => {
      publishCalls.push(event);
    };

    const firstDrain = await drainOutbox(pool, { publish });

    expect(firstDrain.publishedIds).toContain(orderA.outboxEventId);
    expect(firstDrain.publishedIds).toContain(orderB.outboxEventId);
    expect(firstDrain.failedIds).toHaveLength(0);

    const callsForA = publishCalls.filter((e) => e.aggregateId === orderA.orderId);
    const callsForB = publishCalls.filter((e) => e.aggregateId === orderB.orderId);
    expect(callsForA).toHaveLength(1);
    expect(callsForB).toHaveLength(1);

    const publishedAtA = await getPublishedAt(orderA.outboxEventId);
    const publishedAtB = await getPublishedAt(orderB.outboxEventId);
    expect(publishedAtA).not.toBeNull();
    expect(publishedAtB).not.toBeNull();

    // Second drain, immediately: neither of these two events should be
    // touched again - published_at IS NULL is false for both now.
    const secondDrain = await drainOutbox(pool, { publish });

    const callsForAAfterSecond = publishCalls.filter((e) => e.aggregateId === orderA.orderId);
    const callsForBAfterSecond = publishCalls.filter((e) => e.aggregateId === orderB.orderId);
    expect(callsForAAfterSecond).toHaveLength(1);
    expect(callsForBAfterSecond).toHaveLength(1);
    expect(secondDrain.publishedIds).not.toContain(orderA.outboxEventId);
    expect(secondDrain.publishedIds).not.toContain(orderB.outboxEventId);

    // published_at is unchanged from the first drain (not bumped again).
    expect(await getPublishedAt(orderA.outboxEventId)).toEqual(publishedAtA);
    expect(await getPublishedAt(orderB.outboxEventId)).toEqual(publishedAtB);
  });

  it("a publish failure leaves the event unpublished so a later drain can retry it", async () => {
    const customerName = `Drain Failure Test - ${randomUUID()}`;
    const order = await performTransactionalOrderCreation(pool, {
      customerName,
      amountCents: 999,
      injectOutboxInsertFailure: false,
    });
    expect(order.committed).toBe(true);
    if (!order.committed) throw new Error("setup failed");

    const failingPublish = async (event: BrokerEvent) => {
      if (event.aggregateId === order.orderId) {
        throw new Error("simulated broker outage");
      }
    };

    const drainWithFailure = await drainOutbox(pool, { publish: failingPublish });
    expect(drainWithFailure.failedIds).toContain(order.outboxEventId);
    expect(await getPublishedAt(order.outboxEventId)).toBeNull();

    // A later drain, once the broker is healthy again, can still pick it up
    // - `published_at IS NULL` was never set, so the event was never lost.
    const succeedingPublish = async () => {};
    const retryDrain = await drainOutbox(pool, { publish: succeedingPublish });
    expect(retryDrain.publishedIds).toContain(order.outboxEventId);
    expect(await getPublishedAt(order.outboxEventId)).not.toBeNull();
  });
});
