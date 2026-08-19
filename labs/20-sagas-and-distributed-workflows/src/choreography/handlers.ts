import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { cancelOrderStep, refundPaymentStep, releaseInventoryStep } from "../domain/compensating-steps.js";
import { capturePaymentStep, completeOrderStep, createShipmentStep, fetchOrderById, reserveInventoryStep } from "../domain/steps.js";
import type { PaymentRef, ReservationRef, StepName } from "../domain/types.js";
import type { EventBus } from "./event-bus.js";

const log = createLogger("lab20:choreography");

export interface RegisterHandlersOptions {
  failAtStep?: StepName;
}

interface OrderCreatedPayload {
  itemSku: string;
  quantity: number;
  amountCents: number;
}
interface InventoryReservedPayload {
  reservation: ReservationRef;
  amountCents: number;
}
interface PaymentCapturedPayload {
  payment: PaymentRef;
  reservation: ReservationRef;
}
interface InventoryReservationFailedPayload {
  reason: string;
}
interface PaymentFailedPayload {
  reason: string;
  reservation: ReservationRef;
}
interface ShipmentFailedPayload {
  reason: string;
  payment: PaymentRef;
  reservation: ReservationRef;
}
interface PaymentRefundedPayload {
  reservation: ReservationRef;
}

/**
 * Registers one handler per (event, service) pair on `bus`. No function here
 * calls any other - each handler only knows the event it reacts to and the
 * event(s) it may publish next. Compare this file against
 * `src/orchestration/orchestrator.ts`, which is the same four forward steps
 * plus three compensations expressed as ~40 lines of explicit, linear
 * control flow in ONE function: here, the equivalent logic is spread across
 * seven independent handlers, four different "service" names, and there is
 * no single function you could read top-to-bottom to know what happens when
 * `createShipment` fails - you have to follow the event chain
 * (`ShipmentFailed` -> payment-service -> `PaymentRefunded` -> inventory-
 * service -> `InventoryReleased` -> order-service) one hop at a time. That
 * traversal cost is "choreography's observability tradeoff" made concrete -
 * see README "Observe" for the real saga_log numbers.
 *
 * Every business step reuses the exact same `src/domain/steps.ts` /
 * `src/domain/compensating-steps.ts` functions the orchestrator calls,
 * with `mechanism = 'choreography'` - the operations are identical, only
 * the coordination differs.
 */
export function registerHandlers(bus: EventBus, pool: Pool, opts: RegisterHandlersOptions = {}): void {
  // --- forward chain -------------------------------------------------------

  bus.on<OrderCreatedPayload>("OrderCreated", "inventory-service", "forward", async (event) => {
    const order = await fetchOrderById(pool, event.orderId);
    const result = await reserveInventoryStep(
      pool,
      "choreography",
      order,
      event.payload.itemSku,
      event.payload.quantity,
      opts.failAtStep === "reserveInventory",
    );
    log.info({ orderId: order.id, step: "reserveInventory", failed: result.failed }, "handled OrderCreated");

    if (result.failed) {
      await bus.publish<InventoryReservationFailedPayload>(
        { name: "InventoryReservationFailed", orderId: event.orderId, payload: { reason: result.reason } },
        "inventory-service",
        "compensate",
      );
      return;
    }
    await bus.publish<InventoryReservedPayload>(
      {
        name: "InventoryReserved",
        orderId: event.orderId,
        payload: { reservation: result.result, amountCents: event.payload.amountCents },
      },
      "inventory-service",
      "forward",
    );
  });

  bus.on<InventoryReservedPayload>("InventoryReserved", "payment-service", "forward", async (event) => {
    const order = await fetchOrderById(pool, event.orderId);
    const result = await capturePaymentStep(
      pool,
      "choreography",
      order,
      event.payload.amountCents,
      opts.failAtStep === "capturePayment",
    );
    log.info({ orderId: order.id, step: "capturePayment", failed: result.failed }, "handled InventoryReserved");

    if (result.failed) {
      await bus.publish<PaymentFailedPayload>(
        {
          name: "PaymentFailed",
          orderId: event.orderId,
          payload: { reason: result.reason, reservation: event.payload.reservation },
        },
        "payment-service",
        "compensate",
      );
      return;
    }
    await bus.publish<PaymentCapturedPayload>(
      {
        name: "PaymentCaptured",
        orderId: event.orderId,
        payload: { payment: result.result, reservation: event.payload.reservation },
      },
      "payment-service",
      "forward",
    );
  });

  bus.on<PaymentCapturedPayload>("PaymentCaptured", "shipment-service", "forward", async (event) => {
    const order = await fetchOrderById(pool, event.orderId);
    const result = await createShipmentStep(pool, "choreography", order, opts.failAtStep === "createShipment");
    log.info({ orderId: order.id, step: "createShipment", failed: result.failed }, "handled PaymentCaptured");

    if (result.failed) {
      await bus.publish<ShipmentFailedPayload>(
        {
          name: "ShipmentFailed",
          orderId: event.orderId,
          payload: {
            reason: result.reason,
            payment: event.payload.payment,
            reservation: event.payload.reservation,
          },
        },
        "shipment-service",
        "compensate",
      );
      return;
    }
    await bus.publish(
      { name: "ShipmentCreated", orderId: event.orderId, payload: { shipmentId: result.result.shipmentId } },
      "shipment-service",
      "forward",
    );
  });

  bus.on("ShipmentCreated", "order-service", "forward", async (event) => {
    await completeOrderStep(pool, "choreography", event.orderId);
    log.info({ orderId: event.orderId, step: "completeOrder" }, "handled ShipmentCreated");
  });

  // --- compensation chain (each hop reacts only to the event before it) ---

  bus.on<InventoryReservationFailedPayload>("InventoryReservationFailed", "order-service", "compensate", async (event) => {
    await cancelOrderStep(pool, "choreography", event.orderId);
    log.info({ orderId: event.orderId, step: "cancelOrder" }, "handled InventoryReservationFailed");
    await bus.publish({ name: "OrderCancelled", orderId: event.orderId, payload: {} }, "order-service", "compensate");
  });

  bus.on<PaymentFailedPayload>("PaymentFailed", "inventory-service", "compensate", async (event) => {
    await releaseInventoryStep(pool, "choreography", event.orderId, event.payload.reservation);
    log.info({ orderId: event.orderId, step: "releaseInventory" }, "handled PaymentFailed");
    await bus.publish(
      { name: "InventoryReleased", orderId: event.orderId, payload: {} },
      "inventory-service",
      "compensate",
    );
  });

  bus.on<ShipmentFailedPayload>("ShipmentFailed", "payment-service", "compensate", async (event) => {
    await refundPaymentStep(pool, "choreography", event.orderId, event.payload.payment);
    log.info({ orderId: event.orderId, step: "refundPayment" }, "handled ShipmentFailed");
    await bus.publish<PaymentRefundedPayload>(
      { name: "PaymentRefunded", orderId: event.orderId, payload: { reservation: event.payload.reservation } },
      "payment-service",
      "compensate",
    );
  });

  bus.on<PaymentRefundedPayload>("PaymentRefunded", "inventory-service", "compensate", async (event) => {
    await releaseInventoryStep(pool, "choreography", event.orderId, event.payload.reservation);
    log.info({ orderId: event.orderId, step: "releaseInventory" }, "handled PaymentRefunded");
    await bus.publish(
      { name: "InventoryReleased", orderId: event.orderId, payload: {} },
      "inventory-service",
      "compensate",
    );
  });

  bus.on("InventoryReleased", "order-service", "compensate", async (event) => {
    await cancelOrderStep(pool, "choreography", event.orderId);
    log.info({ orderId: event.orderId, step: "cancelOrder" }, "handled InventoryReleased");
    await bus.publish({ name: "OrderCancelled", orderId: event.orderId, payload: {} }, "order-service", "compensate");
  });
}
