import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { performNaiveOrderThenBrokerPublish } from "../../src/scenarios/naive-dual-write-broker-fails.js";
import { performNaiveBrokerPublishThenOrder } from "../../src/scenarios/naive-dual-write-db-fails.js";
import { countOrdersByCustomerName, countOutboxEventsForOrder } from "../../src/scenarios/query-utils.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

/**
 * These tests prove both directions of the dual-write bug are real, on a
 * real Postgres instance - per CLAUDE.md's "show failure before the fix,"
 * not merely narrated in the README.
 */
describe("naive dual write - direction 1: DB commits, broker publish fails", () => {
  it("the order is durably committed, but no outbox_events row exists to recover the fact that it still needs publishing", async () => {
    const customerName = `Naive Broker Fails Test - ${randomUUID()}`;

    const result = await performNaiveOrderThenBrokerPublish(pool, {
      customerName,
      amountCents: 4_999,
    });

    // The order write genuinely succeeded and is durable - this is not in
    // question, it is the whole problem.
    expect(result.orderCommitted).toBe(true);
    expect(result.brokerPublished).toBe(false);
    expect(result.brokerError).toMatch(/simulated broker publish failure/);

    const orderCount = await countOrdersByCustomerName(pool, customerName);
    expect(orderCount).toBe(1);

    // This is the assertable half of "no way to know from queryable state":
    // no outbox_events row exists at all for this order, in this naive
    // version, because the naive path never touches that table. There is
    // nothing in this database a reconciliation job could query to discover
    // this order still needs to be published.
    const outboxCount = await countOutboxEventsForOrder(pool, result.orderId);
    expect(outboxCount).toBe(0);
  });
});

describe("naive dual write - direction 2: broker publish succeeds, DB write fails afterward", () => {
  it("the broker call succeeds, but the order row never exists - a phantom event", async () => {
    const customerName = `Naive DB Fails Test - ${randomUUID()}`;

    const result = await performNaiveBrokerPublishThenOrder(pool, {
      customerName,
      amountCents: 7_500,
    });

    expect(result.brokerPublished).toBe(true);
    expect(result.orderCommitted).toBe(false);
    if (!result.orderCommitted) {
      // orders_amount_cents_positive CHECK violation - a real Postgres error
      // code, not a narrated one.
      expect(result.dbErrorCode).toBe("23514");
    }

    // The core assertion: despite the broker believing the event was sent,
    // no order row for this customer name exists anywhere.
    const orderCount = await countOrdersByCustomerName(pool, customerName);
    expect(orderCount).toBe(0);
  });
});
