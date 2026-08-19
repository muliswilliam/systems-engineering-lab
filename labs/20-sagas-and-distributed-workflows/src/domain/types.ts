/** The four forward saga steps, in order. Shared by orchestration and choreography. */
export type StepName = "createOrder" | "reserveInventory" | "capturePayment" | "createShipment";

export type Mechanism = "orchestration" | "choreography";

export type Direction = "forward" | "compensate";

export interface OrderSagaInput {
  customerName: string;
  amountCents: number;
  itemSku: string;
  quantity: number;
}

export interface OrderRef {
  id: number;
  publicId: string;
}

export interface ReservationRef {
  reservationId: number;
  itemId: number;
  quantity: number;
}

export interface PaymentRef {
  paymentId: number;
}

/** Result of any single saga step attempt (forward or compensating). */
export type StepOutcome<T> = { failed: false; result: T } | { failed: true; reason: string };

/**
 * Final result of a full saga run (either mechanism). `outcome`:
 *   - `completed`  all four forward steps succeeded.
 *   - `compensated` a step after `createOrder` failed and every
 *                    already-succeeded step was compensated; the order
 *                    ends up `cancelled`.
 *   - `aborted`     `createOrder` itself failed - no order row exists at
 *                    all, so there is nothing to compensate.
 */
export type SagaOutcome = "completed" | "compensated" | "aborted";

export interface SagaResult {
  outcome: SagaOutcome;
  orderId: number | null;
  publicId?: string;
  failedStep?: StepName;
  reason?: string;
}

/** Thrown internally to short-circuit a step's transaction when a failure is
 * deliberately injected via `opts.failAtStep`. Always caught within the step
 * function itself - callers only ever see a `StepOutcome`, never this class. */
export class SagaStepError extends Error {
  constructor(
    public readonly stepName: StepName,
    message: string,
  ) {
    super(message);
    this.name = "SagaStepError";
  }
}
