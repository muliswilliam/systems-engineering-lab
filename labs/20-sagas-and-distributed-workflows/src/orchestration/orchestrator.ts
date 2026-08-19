import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import {
  capturePaymentStep,
  completeOrderStep,
  createOrderStep,
  createShipmentStep,
  reserveInventoryStep,
} from "../domain/steps.js";
import type { OrderSagaInput, SagaResult, StepName } from "../domain/types.js";
import { cancelOrder, refundPayment, releaseInventory } from "./compensation.js";

const log = createLogger("lab20:orchestrator");

export interface RunOrderSagaOptions {
  /** Force a specific forward step to fail, deterministically, for
   * scenarios/tests. See src/domain/run-step.ts for exactly how/when the
   * failure is injected (before any business write in that step's
   * transaction). */
  failAtStep?: StepName;
}

/**
 * THE ORCHESTRATED SAGA: a single coordinator function that calls each step
 * directly, in order, and - on any failure - calls the matching
 * compensations directly, in reverse order, for every step that already
 * succeeded. This is "orchestration": one place in the code that knows the
 * whole workflow and its failure handling.
 *
 * Each step is its OWN small transaction (see src/domain/run-step.ts) - the
 * whole saga is deliberately never wrapped in one giant transaction. A
 * single Postgres transaction spanning all four steps would defeat the
 * point of a saga (and isn't available to a real multi-service system
 * anyway): the steps here are modeled as if they were separate services,
 * each committing its own local transaction, with the ONLY thing tying them
 * together being this function's own control flow and the compensations it
 * runs if something downstream fails.
 *
 * Every step's log line below includes `orderId` and `step`, per this
 * repository's logging convention, so a single order's full execution is
 * traceable from the process logs alone, not just from `saga_log`.
 */
export async function runOrderSaga(
  pool: Pool,
  input: OrderSagaInput,
  opts: RunOrderSagaOptions = {},
): Promise<SagaResult> {
  const createResult = await createOrderStep(pool, "orchestration", input, opts.failAtStep === "createOrder");
  if (createResult.failed) {
    log.error({ step: "createOrder", reason: createResult.reason }, "saga aborted - order was never created");
    return { outcome: "aborted", orderId: null, failedStep: "createOrder", reason: createResult.reason };
  }
  const order = createResult.result;
  log.info({ orderId: order.id, step: "createOrder" }, "step succeeded");

  const reserveResult = await reserveInventoryStep(
    pool,
    "orchestration",
    order,
    input.itemSku,
    input.quantity,
    opts.failAtStep === "reserveInventory",
  );
  if (reserveResult.failed) {
    log.warn(
      { orderId: order.id, step: "reserveInventory", reason: reserveResult.reason },
      "step failed - compensating already-succeeded steps",
    );
    await cancelOrder(pool, order.id);
    log.info({ orderId: order.id, step: "cancelOrder" }, "compensation succeeded");
    return {
      outcome: "compensated",
      orderId: order.id,
      publicId: order.publicId,
      failedStep: "reserveInventory",
      reason: reserveResult.reason,
    };
  }
  log.info({ orderId: order.id, step: "reserveInventory" }, "step succeeded");

  const paymentResult = await capturePaymentStep(
    pool,
    "orchestration",
    order,
    input.amountCents,
    opts.failAtStep === "capturePayment",
  );
  if (paymentResult.failed) {
    log.warn(
      { orderId: order.id, step: "capturePayment", reason: paymentResult.reason },
      "step failed - compensating already-succeeded steps",
    );
    await releaseInventory(pool, order.id, reserveResult.result);
    log.info({ orderId: order.id, step: "releaseInventory" }, "compensation succeeded");
    await cancelOrder(pool, order.id);
    log.info({ orderId: order.id, step: "cancelOrder" }, "compensation succeeded");
    return {
      outcome: "compensated",
      orderId: order.id,
      publicId: order.publicId,
      failedStep: "capturePayment",
      reason: paymentResult.reason,
    };
  }
  log.info({ orderId: order.id, step: "capturePayment" }, "step succeeded");

  const shipmentResult = await createShipmentStep(pool, "orchestration", order, opts.failAtStep === "createShipment");
  if (shipmentResult.failed) {
    log.warn(
      { orderId: order.id, step: "createShipment", reason: shipmentResult.reason },
      "step failed - compensating already-succeeded steps, in reverse order",
    );
    await refundPayment(pool, order.id, paymentResult.result);
    log.info({ orderId: order.id, step: "refundPayment" }, "compensation succeeded");
    await releaseInventory(pool, order.id, reserveResult.result);
    log.info({ orderId: order.id, step: "releaseInventory" }, "compensation succeeded");
    await cancelOrder(pool, order.id);
    log.info({ orderId: order.id, step: "cancelOrder" }, "compensation succeeded");
    return {
      outcome: "compensated",
      orderId: order.id,
      publicId: order.publicId,
      failedStep: "createShipment",
      reason: shipmentResult.reason,
    };
  }
  log.info({ orderId: order.id, step: "createShipment" }, "step succeeded");

  await completeOrderStep(pool, "orchestration", order.id);
  log.info({ orderId: order.id, step: "completeOrder" }, "saga completed");

  return { outcome: "completed", orderId: order.id, publicId: order.publicId };
}
