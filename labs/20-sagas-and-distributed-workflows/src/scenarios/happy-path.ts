import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runOrderSaga } from "../orchestration/orchestrator.js";
import {
  getInventoryQuantity,
  getLatestPaymentStatus,
  getLatestReservationStatus,
  getOrderStatus,
  getShipmentCount,
} from "./query-helpers.js";

const log = createLogger("lab20:scenario:happy-path");

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * THE ORCHESTRATED SAGA, HAPPY PATH: no failure injected. All four forward
 * steps succeed - `createOrder`, `reserveInventory`, `capturePayment`,
 * `createShipment` - and the order ends `completed`. Run after `pnpm seed`.
 */
export async function runHappyPathScenario() {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const itemSku = "SKU-KEYBOARD-001";
  const quantity = 2;
  const amountCents = 12_999;

  const quantityBefore = await getInventoryQuantity(pool, itemSku);
  log.info({ itemSku, quantityBefore }, "inventory before saga");

  const result = await runOrderSaga(pool, {
    customerName: "Ada Lovelace",
    amountCents,
    itemSku,
    quantity,
  });

  log.info(result, "saga finished");
  assertEqual(result.outcome, "completed", "expected the happy-path saga to complete");
  const orderId = result.orderId!;

  const [orderStatus, quantityAfter, reservationStatus, paymentStatus, shipmentCount] = await Promise.all([
    getOrderStatus(pool, orderId),
    getInventoryQuantity(pool, itemSku),
    getLatestReservationStatus(pool, orderId),
    getLatestPaymentStatus(pool, orderId),
    getShipmentCount(pool, orderId),
  ]);

  assertEqual(orderStatus, "completed", "order.status");
  assertEqual(quantityAfter, quantityBefore - quantity, "inventory_items.available_quantity");
  assertEqual(reservationStatus, "reserved", "inventory_reservations.status");
  assertEqual(paymentStatus, "captured", "payments.status");
  assertEqual(shipmentCount, 1, "shipments row count");

  log.info(
    {
      orderId,
      orderStatus,
      itemSku,
      quantityBefore,
      quantityAfter,
      reservationStatus,
      paymentStatus,
      shipmentCount,
    },
    "HAPPY PATH CONFIRMED: order completed, inventory decremented, payment captured, shipment created",
  );

  await pool.end();
  return result;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runHappyPathScenario().catch((error: unknown) => {
    log.error({ err: error }, "happy-path scenario failed");
    process.exit(1);
  });
}
