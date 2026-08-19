import type { Pool } from "pg";
import {
  cancelOrderStep,
  refundPaymentStep,
  releaseInventoryStep,
} from "../domain/compensating-steps.js";
import type { PaymentRef, ReservationRef, StepOutcome } from "../domain/types.js";

/**
 * The orchestrator's compensation actions - thin, orchestration-mechanism
 * bindings over the shared `src/domain/compensating-steps.ts` functions (the
 * choreography handlers in `src/choreography/handlers.ts` call the exact
 * same underlying functions with `mechanism = 'choreography'`; see README
 * "Architecture" for why the business operations are shared but the
 * coordination is not).
 *
 * `runOrderSaga` (orchestrator.ts) calls these three, in REVERSE order of
 * whichever forward steps already succeeded, when a later step fails:
 *
 *   createShipment fails   -> refundPayment, releaseInventory, cancelOrder
 *   capturePayment fails   ->                releaseInventory, cancelOrder
 *   reserveInventory fails ->                                  cancelOrder
 */

export async function refundPayment(
  pool: Pool,
  orderId: number,
  payment: PaymentRef,
): Promise<StepOutcome<Record<string, never>>> {
  return refundPaymentStep(pool, "orchestration", orderId, payment);
}

export async function releaseInventory(
  pool: Pool,
  orderId: number,
  reservation: ReservationRef,
): Promise<StepOutcome<Record<string, never>>> {
  return releaseInventoryStep(pool, "orchestration", orderId, reservation);
}

export async function cancelOrder(pool: Pool, orderId: number): Promise<StepOutcome<Record<string, never>>> {
  return cancelOrderStep(pool, "orchestration", orderId);
}
