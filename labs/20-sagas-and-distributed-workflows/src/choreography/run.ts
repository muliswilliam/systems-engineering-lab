import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createOrderStep } from "../domain/steps.js";
import type { OrderSagaInput, StepName } from "../domain/types.js";
import { EventBus } from "./event-bus.js";
import { registerHandlers } from "./handlers.js";

const log = createLogger("lab20:choreography:run");

export interface RunChoreographedSagaOptions {
  failAtStep?: StepName;
}

export interface ChoreographedSagaHandle {
  orderId: number | null;
  publicId?: string;
  aborted: boolean;
}

/**
 * THE CHOREOGRAPHED SAGA: there is no coordinator function here that "runs
 * the saga." `order-service` only ever does two things: create the order,
 * and react to `ShipmentCreated`/`InventoryReservationFailed`/
 * `InventoryReleased`. It has no idea a payment or a shipment step even
 * exists - each service only knows the event immediately before it in the
 * chain (see `src/choreography/handlers.ts`).
 *
 * A fresh `EventBus` (and fresh handler registrations) is created per call
 * so concurrent/sequential saga runs in the same process never cross-wire
 * events between orders that happen to be in flight at once.
 *
 * Because `EventBus.publish` awaits every subscriber's handler, and every
 * handler awaits its own downstream `publish` calls, this `await` does not
 * return until the entire event cascade for this order has finished -
 * there is no background queue left running after this function returns.
 */
export async function runChoreographedOrderSaga(
  pool: Pool,
  input: OrderSagaInput,
  opts: RunChoreographedSagaOptions = {},
): Promise<ChoreographedSagaHandle> {
  const bus = new EventBus(pool);
  registerHandlers(bus, pool, opts);

  const createResult = await createOrderStep(pool, "choreography", input, opts.failAtStep === "createOrder");
  if (createResult.failed) {
    log.error({ step: "createOrder", reason: createResult.reason }, "saga aborted - order was never created");
    return { orderId: null, aborted: true };
  }
  const order = createResult.result;
  log.info({ orderId: order.id, step: "createOrder" }, "published OrderCreated");

  await bus.publish(
    {
      name: "OrderCreated",
      orderId: order.id,
      payload: { itemSku: input.itemSku, quantity: input.quantity, amountCents: input.amountCents },
    },
    "order-service",
    "forward",
  );

  return { orderId: order.id, publicId: order.publicId, aborted: false };
}
