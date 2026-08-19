import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
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

describe("orchestrated saga - happy path", () => {
  it("leaves all four business tables in their success state", async () => {
    const itemSku = "TEST-SKU-A";
    const quantityBefore = await getInventoryQuantity(pool, itemSku);

    const result = await runOrderSaga(pool, {
      customerName: "Orchestration Happy Customer",
      amountCents: 5_000,
      itemSku,
      quantity: 3,
    });

    expect(result.outcome).toBe("completed");
    const orderId = result.orderId!;

    expect(await getOrderStatus(pool, orderId)).toBe("completed");
    expect(await getInventoryQuantity(pool, itemSku)).toBe(quantityBefore - 3);
    expect(await getLatestReservationStatus(pool, orderId)).toBe("reserved");
    expect(await getLatestPaymentStatus(pool, orderId)).toBe("captured");
    expect(await getShipmentCount(pool, orderId)).toBe(1);
  });
});

describe("orchestrated saga - failure after payment, with compensation", () => {
  it("refunds payment, releases inventory back to its exact pre-reservation count, and cancels the order", async () => {
    const itemSku = "TEST-SKU-B";
    const quantityBefore = await getInventoryQuantity(pool, itemSku);

    const result = await runOrderSaga(
      pool,
      { customerName: "Orchestration Failure Customer", amountCents: 7_500, itemSku, quantity: 4 },
      { failAtStep: "createShipment" },
    );

    expect(result.outcome).toBe("compensated");
    expect(result.failedStep).toBe("createShipment");
    const orderId = result.orderId!;

    // THE key invariant: the inventory count is restored to the exact
    // pre-reservation value, not merely a status string.
    const quantityAfter = await getInventoryQuantity(pool, itemSku);
    expect(quantityAfter).toBe(quantityBefore);

    expect(await getOrderStatus(pool, orderId)).toBe("cancelled");
    expect(await getLatestReservationStatus(pool, orderId)).toBe("released");
    expect(await getLatestPaymentStatus(pool, orderId)).toBe("refunded");
    expect(await getShipmentCount(pool, orderId)).toBe(0);
  });

  it("compensates a failure at capturePayment (only inventory needs releasing, no payment was ever captured)", async () => {
    const itemSku = "TEST-SKU-C";
    const quantityBefore = await getInventoryQuantity(pool, itemSku);

    const result = await runOrderSaga(
      pool,
      { customerName: "Orchestration Payment Failure Customer", amountCents: 1_200, itemSku, quantity: 2 },
      { failAtStep: "capturePayment" },
    );

    expect(result.outcome).toBe("compensated");
    expect(result.failedStep).toBe("capturePayment");
    const orderId = result.orderId!;

    expect(await getInventoryQuantity(pool, itemSku)).toBe(quantityBefore);
    expect(await getOrderStatus(pool, orderId)).toBe("cancelled");
    expect(await getLatestReservationStatus(pool, orderId)).toBe("released");
    expect(await getLatestPaymentStatus(pool, orderId)).toBeNull();
    expect(await getShipmentCount(pool, orderId)).toBe(0);
  });
});
