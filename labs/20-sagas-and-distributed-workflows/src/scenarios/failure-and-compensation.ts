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

const log = createLogger("lab20:scenario:failure-and-compensation");

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * THE ORCHESTRATED SAGA, FAILURE AFTER PAYMENT: `createShipment` is forced
 * to fail (`opts.failAtStep`). `createOrder`, `reserveInventory`, and
 * `capturePayment` have already succeeded and committed by the time this
 * happens - see README "Break it" for what would be left behind here
 * WITHOUT compensation (a captured payment and reserved inventory with no
 * shipment ever going out). This script proves the actual fix: compensation
 * runs in reverse order (refundPayment, releaseInventory, cancelOrder), and
 * the inventory count genuinely returns to its pre-reservation value - not
 * just a status string flipping.
 */
export async function runFailureAndCompensationScenario() {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const itemSku = "SKU-MONITOR-004";
  const quantity = 1;
  const amountCents = 34_999;

  const quantityBefore = await getInventoryQuantity(pool, itemSku);
  log.info({ itemSku, quantityBefore }, "inventory before saga");

  const result = await runOrderSaga(
    pool,
    { customerName: "Grace Hopper", amountCents, itemSku, quantity },
    { failAtStep: "createShipment" },
  );

  log.info(result, "saga finished");
  assertEqual(result.outcome, "compensated", "expected the saga to be compensated");
  assertEqual(result.failedStep, "createShipment", "expected the injected failure at createShipment");
  const orderId = result.orderId!;

  const [orderStatus, quantityAfter, reservationStatus, paymentStatus, shipmentCount] = await Promise.all([
    getOrderStatus(pool, orderId),
    getInventoryQuantity(pool, itemSku),
    getLatestReservationStatus(pool, orderId),
    getLatestPaymentStatus(pool, orderId),
    getShipmentCount(pool, orderId),
  ]);

  assertEqual(orderStatus, "cancelled", "order.status after compensation");
  // THE key invariant: the inventory count is back to what it was BEFORE
  // this saga ever reserved anything - not just a status flag.
  assertEqual(quantityAfter, quantityBefore, "inventory_items.available_quantity restored");
  assertEqual(reservationStatus, "released", "inventory_reservations.status");
  assertEqual(paymentStatus, "refunded", "payments.status");
  assertEqual(shipmentCount, 0, "no shipment row should ever have been created");

  log.info(
    {
      orderId,
      orderStatus,
      itemSku,
      quantityBefore,
      quantityAfter,
      inventoryRestored: quantityAfter === quantityBefore,
      reservationStatus,
      paymentStatus,
      shipmentCount,
    },
    "COMPENSATION CONFIRMED: payment refunded, inventory released back to its exact pre-reservation count, order cancelled, no shipment exists",
  );

  await pool.end();
  return result;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runFailureAndCompensationScenario().catch((error: unknown) => {
    log.error({ err: error }, "failure-and-compensation scenario failed");
    process.exit(1);
  });
}
