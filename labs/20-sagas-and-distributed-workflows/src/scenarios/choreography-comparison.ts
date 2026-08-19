import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runOrderSaga } from "../orchestration/orchestrator.js";
import { runChoreographedOrderSaga } from "../choreography/run.js";
import {
  getInventoryQuantity,
  getLatestPaymentStatus,
  getLatestReservationStatus,
  getOrderStatus,
  getSagaLogSummary,
  getShipmentCount,
} from "./query-helpers.js";

const log = createLogger("lab20:scenario:choreography-comparison");

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * Runs the SAME happy-path and SAME failure-after-payment scenario through
 * BOTH mechanisms (fresh orders each, distinct SKUs so the four runs don't
 * interfere with each other's inventory counts) and prints a side-by-side
 * comparison: final business-table outcomes (must match between the two
 * mechanisms) and `saga_log` traceability (which does NOT match - that
 * mismatch is the whole point of this script, made concrete with real
 * counted numbers instead of asserted in prose).
 */
export async function runChoreographyComparisonScenario() {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  // --- happy path, both mechanisms -----------------------------------------
  const happySku = "SKU-MOUSE-002";
  const orchestratedHappy = await runOrderSaga(pool, {
    customerName: "Katherine Johnson",
    amountCents: 4_999,
    itemSku: happySku,
    quantity: 1,
  });
  const choreographedHappy = await runChoreographedOrderSaga(pool, {
    customerName: "Katherine Johnson",
    amountCents: 4_999,
    itemSku: happySku,
    quantity: 1,
  });

  assertEqual(orchestratedHappy.outcome, "completed", "orchestrated happy path outcome");
  assertEqual(choreographedHappy.aborted, false, "choreographed happy path outcome");

  const [orchestratedHappyStatus, choreographedHappyStatus] = await Promise.all([
    getOrderStatus(pool, orchestratedHappy.orderId!),
    getOrderStatus(pool, choreographedHappy.orderId!),
  ]);
  assertEqual(orchestratedHappyStatus, "completed", "orchestrated happy order status");
  assertEqual(
    choreographedHappyStatus,
    orchestratedHappyStatus,
    "choreographed happy order status must equal orchestrated happy order status",
  );

  const [orchestratedHappyPayment, choreographedHappyPayment] = await Promise.all([
    getLatestPaymentStatus(pool, orchestratedHappy.orderId!),
    getLatestPaymentStatus(pool, choreographedHappy.orderId!),
  ]);
  assertEqual(choreographedHappyPayment, orchestratedHappyPayment, "happy-path payment status equivalence");

  const [orchestratedHappyShipments, choreographedHappyShipments] = await Promise.all([
    getShipmentCount(pool, orchestratedHappy.orderId!),
    getShipmentCount(pool, choreographedHappy.orderId!),
  ]);
  assertEqual(choreographedHappyShipments, orchestratedHappyShipments, "happy-path shipment count equivalence");

  // --- failure after payment, both mechanisms ------------------------------
  const failureSku = "SKU-HUB-003";
  const quantityBeforeOrchestrated = await getInventoryQuantity(pool, failureSku);
  const orchestratedFailure = await runOrderSaga(
    pool,
    { customerName: "Margaret Hamilton", amountCents: 2_499, itemSku: failureSku, quantity: 1 },
    { failAtStep: "createShipment" },
  );
  const quantityAfterOrchestrated = await getInventoryQuantity(pool, failureSku);

  const quantityBeforeChoreographed = await getInventoryQuantity(pool, failureSku);
  const choreographedFailure = await runChoreographedOrderSaga(
    pool,
    { customerName: "Margaret Hamilton", amountCents: 2_499, itemSku: failureSku, quantity: 1 },
    { failAtStep: "createShipment" },
  );
  const quantityAfterChoreographed = await getInventoryQuantity(pool, failureSku);

  assertEqual(quantityAfterOrchestrated, quantityBeforeOrchestrated, "orchestrated inventory restored");
  assertEqual(quantityAfterChoreographed, quantityBeforeChoreographed, "choreographed inventory restored");

  const [orchestratedFailureStatus, choreographedFailureStatus] = await Promise.all([
    getOrderStatus(pool, orchestratedFailure.orderId!),
    getOrderStatus(pool, choreographedFailure.orderId!),
  ]);
  assertEqual(orchestratedFailureStatus, "cancelled", "orchestrated failure order status");
  assertEqual(
    choreographedFailureStatus,
    orchestratedFailureStatus,
    "choreographed failure order status must equal orchestrated failure order status",
  );

  const [orchestratedFailureReservation, choreographedFailureReservation] = await Promise.all([
    getLatestReservationStatus(pool, orchestratedFailure.orderId!),
    getLatestReservationStatus(pool, choreographedFailure.orderId!),
  ]);
  assertEqual(
    choreographedFailureReservation,
    orchestratedFailureReservation,
    "failure-path reservation status equivalence",
  );

  const [orchestratedFailurePayment, choreographedFailurePayment] = await Promise.all([
    getLatestPaymentStatus(pool, orchestratedFailure.orderId!),
    getLatestPaymentStatus(pool, choreographedFailure.orderId!),
  ]);
  assertEqual(choreographedFailurePayment, orchestratedFailurePayment, "failure-path payment status equivalence");

  // --- saga_log observability comparison -----------------------------------
  const [orchestratedHappyLog, choreographedHappyLog, orchestratedFailureLog, choreographedFailureLog] =
    await Promise.all([
      getSagaLogSummary(pool, orchestratedHappy.orderId!, "orchestration"),
      getSagaLogSummary(pool, choreographedHappy.orderId!, "choreography"),
      getSagaLogSummary(pool, orchestratedFailure.orderId!, "orchestration"),
      getSagaLogSummary(pool, choreographedFailure.orderId!, "choreography"),
    ]);

  const comparison = {
    happyPath: {
      orchestration: { entryCount: orchestratedHappyLog.entryCount, distinctActors: orchestratedHappyLog.distinctActors },
      choreography: { entryCount: choreographedHappyLog.entryCount, distinctActors: choreographedHappyLog.distinctActors },
    },
    failureAndCompensation: {
      orchestration: {
        entryCount: orchestratedFailureLog.entryCount,
        distinctActors: orchestratedFailureLog.distinctActors,
      },
      choreography: {
        entryCount: choreographedFailureLog.entryCount,
        distinctActors: choreographedFailureLog.distinctActors,
      },
    },
  };

  log.info(comparison, "SAGA_LOG COMPARISON: choreography needs more log rows and more distinct actors to trace the identical business outcome");

  if (choreographedHappyLog.entryCount <= orchestratedHappyLog.entryCount) {
    throw new Error("expected choreography to produce MORE saga_log rows than orchestration for the happy path");
  }
  if (choreographedFailureLog.entryCount <= orchestratedFailureLog.entryCount) {
    throw new Error("expected choreography to produce MORE saga_log rows than orchestration for the failure path");
  }
  if (choreographedHappyLog.distinctActors.length <= orchestratedHappyLog.distinctActors.length) {
    throw new Error("expected choreography to involve MORE distinct actors than orchestration for the happy path");
  }

  await pool.end();
  return comparison;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runChoreographyComparisonScenario().catch((error: unknown) => {
    log.error({ err: error }, "choreography-comparison scenario failed");
    process.exit(1);
  });
}
