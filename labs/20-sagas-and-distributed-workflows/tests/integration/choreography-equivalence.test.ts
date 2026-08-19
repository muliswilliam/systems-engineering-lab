import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { runChoreographedOrderSaga } from "../../src/choreography/run.js";
import { runOrderSaga } from "../../src/orchestration/orchestrator.js";
import {
  getInventoryQuantity,
  getLatestPaymentStatus,
  getLatestReservationStatus,
  getOrderStatus,
  getShipmentCount,
} from "../../src/scenarios/query-helpers.js";
import { resetDatabase } from "./catalog-helpers.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await resetDatabase();
});

afterAll(async () => {
  await pool.end();
});

/**
 * Per this lab's core claim: the two mechanisms differ in HOW the workflow
 * is coordinated, not in WHAT the workflow accomplishes. These tests assert
 * that equivalence directly - same business inputs, same final business
 * outcomes - even though the internal mechanics (a linear function call vs
 * an event cascade across independent handlers) are completely different.
 */
describe("choreography produces the same business outcomes as orchestration", () => {
  it("happy path: order completed, inventory decremented, payment captured, shipment created - same as orchestration", async () => {
    const itemSku = "TEST-SKU-A";
    const quantity = 2;
    const quantityBefore = await getInventoryQuantity(pool, itemSku);

    const orchestrated = await runOrderSaga(pool, {
      customerName: "Equivalence Happy Orchestrated",
      amountCents: 3_000,
      itemSku,
      quantity,
    });
    const choreographed = await runChoreographedOrderSaga(pool, {
      customerName: "Equivalence Happy Choreographed",
      amountCents: 3_000,
      itemSku,
      quantity,
    });

    expect(orchestrated.outcome).toBe("completed");
    expect(choreographed.aborted).toBe(false);

    const orchestratedOrderId = orchestrated.orderId!;
    const choreographedOrderId = choreographed.orderId!;

    expect(await getOrderStatus(pool, choreographedOrderId)).toBe(await getOrderStatus(pool, orchestratedOrderId));
    expect(await getLatestReservationStatus(pool, choreographedOrderId)).toBe(
      await getLatestReservationStatus(pool, orchestratedOrderId),
    );
    expect(await getLatestPaymentStatus(pool, choreographedOrderId)).toBe(
      await getLatestPaymentStatus(pool, orchestratedOrderId),
    );
    expect(await getShipmentCount(pool, choreographedOrderId)).toBe(await getShipmentCount(pool, orchestratedOrderId));

    // Both sagas reserved `quantity` units each - inventory dropped by 2x.
    const quantityAfter = await getInventoryQuantity(pool, itemSku);
    expect(quantityAfter).toBe(quantityBefore - quantity * 2);
  });

  it("failure after payment: both mechanisms refund, release inventory to the same restored count, and cancel the order", async () => {
    const itemSku = "TEST-SKU-B";
    const quantity = 3;

    const quantityBeforeOrchestrated = await getInventoryQuantity(pool, itemSku);
    const orchestrated = await runOrderSaga(
      pool,
      { customerName: "Equivalence Failure Orchestrated", amountCents: 6_000, itemSku, quantity },
      { failAtStep: "createShipment" },
    );
    const quantityAfterOrchestrated = await getInventoryQuantity(pool, itemSku);

    const quantityBeforeChoreographed = await getInventoryQuantity(pool, itemSku);
    const choreographed = await runChoreographedOrderSaga(
      pool,
      { customerName: "Equivalence Failure Choreographed", amountCents: 6_000, itemSku, quantity },
      { failAtStep: "createShipment" },
    );
    const quantityAfterChoreographed = await getInventoryQuantity(pool, itemSku);

    expect(orchestrated.outcome).toBe("compensated");
    expect(choreographed.aborted).toBe(false);

    // Both mechanisms fully restore the quantity they individually reserved.
    expect(quantityAfterOrchestrated).toBe(quantityBeforeOrchestrated);
    expect(quantityAfterChoreographed).toBe(quantityBeforeChoreographed);

    const orchestratedOrderId = orchestrated.orderId!;
    const choreographedOrderId = choreographed.orderId!;

    expect(await getOrderStatus(pool, choreographedOrderId)).toBe("cancelled");
    expect(await getOrderStatus(pool, choreographedOrderId)).toBe(await getOrderStatus(pool, orchestratedOrderId));
    expect(await getLatestReservationStatus(pool, choreographedOrderId)).toBe(
      await getLatestReservationStatus(pool, orchestratedOrderId),
    );
    expect(await getLatestPaymentStatus(pool, choreographedOrderId)).toBe(
      await getLatestPaymentStatus(pool, orchestratedOrderId),
    );
    expect(await getShipmentCount(pool, choreographedOrderId)).toBe(0);
  });
});
