import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { performTransactionalOrderCreation } from "../../src/scenarios/transactional-outbox.js";
import {
  countOrdersByCustomerName,
  countOutboxEventsForOrder,
  findOrderWithOutboxEventByCustomerName,
} from "../../src/scenarios/query-utils.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

describe("transactional outbox (BEGIN; INSERT order; INSERT outbox_event; COMMIT)", () => {
  it("happy path: exactly one orders row and one outbox_events row, both visible in the same join", async () => {
    const customerName = `Outbox Happy Test - ${randomUUID()}`;

    const result = await performTransactionalOrderCreation(pool, {
      customerName,
      amountCents: 3_200,
      injectOutboxInsertFailure: false,
    });

    expect(result.committed).toBe(true);

    const orderCount = await countOrdersByCustomerName(pool, customerName);
    expect(orderCount).toBe(1);

    if (result.committed) {
      const outboxCount = await countOutboxEventsForOrder(pool, result.orderId);
      expect(outboxCount).toBe(1);
    }

    const joined = await findOrderWithOutboxEventByCustomerName(pool, customerName);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.eventType).toBe("OrderCreated");
    expect(joined[0]!.amountCents).toBe(3_200);
    // Not yet published - this scenario never calls the broker, by design.
    expect(joined[0]!.publishedAt).toBeNull();
  });

  it("the outbox INSERT failing rolls back BOTH the order row and the outbox event row - core atomicity", async () => {
    const customerName = `Outbox Rollback Test - ${randomUUID()}`;

    const result = await performTransactionalOrderCreation(pool, {
      customerName,
      amountCents: 3_200,
      injectOutboxInsertFailure: true,
    });

    expect(result.committed).toBe(false);
    if (!result.committed) {
      expect(result.reason).toMatch(/outbox_events_event_type_valid/);
    }

    // Neither row exists - not "the order exists but unpublished," not "a
    // partial outbox row exists." Nothing at all, because the whole
    // transaction rolled back.
    const orderCount = await countOrdersByCustomerName(pool, customerName);
    expect(orderCount).toBe(0);

    const joined = await findOrderWithOutboxEventByCustomerName(pool, customerName);
    expect(joined).toHaveLength(0);
  });

  it("publishToBroker is never imported by the transactional-outbox write path", async () => {
    // A structural guarantee, not a runtime spy: the write path in
    // src/scenarios/transactional-outbox.ts does not import ./broker.js at
    // all, so it is impossible for performTransactionalOrderCreation to call
    // the broker synchronously - publishing only ever happens later, via
    // src/scripts/drain-outbox.ts. Read the source file directly here so
    // this test breaks (loudly) if that ever changes.
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const sourcePath = url.fileURLToPath(
      new URL("../../src/scenarios/transactional-outbox.ts", import.meta.url),
    );
    const source = await fs.readFile(sourcePath, "utf8");
    expect(source).not.toMatch(/from ["']\.\/broker\.js["']/);
    expect(source).not.toContain("publishToBroker(");
  });
});
