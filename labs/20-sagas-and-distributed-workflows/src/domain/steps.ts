import type { Pool } from "pg";
import { insertSagaLog } from "./saga-log.js";
import { runStep } from "./run-step.js";
import type { Mechanism, OrderRef, OrderSagaInput, PaymentRef, ReservationRef, StepOutcome } from "./types.js";
import { SagaStepError } from "./types.js";

/**
 * The four forward saga steps, mechanism-agnostic (the same functions are
 * called directly by the orchestrator and reacted-to by the choreography
 * event handlers - see README "Architecture": same business operations,
 * two different coordination styles).
 */

/**
 * `createOrder` is handled outside `runStep` because, uniquely among the
 * four steps, a failure here means the order row itself never existed (the
 * INSERT rolled back) - there is no valid `orders.id` left to attach a
 * `saga_log` row to via the normal foreign key, so the failure log is
 * written with `order_id = null` instead.
 */
export async function createOrderStep(
  pool: Pool,
  mechanism: Mechanism,
  input: OrderSagaInput,
  simulateFailure = false,
): Promise<StepOutcome<OrderRef>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (simulateFailure) {
      throw new SagaStepError(
        "createOrder",
        `simulated failure: order intake rejected for customer "${input.customerName}"`,
      );
    }

    const insertResult = await client.query<{ id: number; public_id: string }>(
      `INSERT INTO orders (customer_name, amount_cents, status)
       VALUES ($1, $2, 'pending')
       RETURNING id, public_id`,
      [input.customerName, input.amountCents],
    );
    const row = insertResult.rows[0]!;

    await insertSagaLog(client, {
      orderId: row.id,
      mechanism,
      stepName: "createOrder",
      direction: "forward",
      outcome: "success",
      detail: { customerName: input.customerName, amountCents: input.amountCents },
    });

    await client.query("COMMIT");
    return { failed: false, result: { id: row.id, publicId: row.public_id } };
  } catch (error) {
    await client.query("ROLLBACK");
    const reason = error instanceof Error ? error.message : String(error);

    await insertSagaLog(pool, {
      orderId: null,
      mechanism,
      stepName: "createOrder",
      direction: "forward",
      outcome: "failure",
      detail: { customerName: input.customerName, reason },
    });

    return { failed: true, reason };
  } finally {
    client.release();
  }
}

export async function reserveInventoryStep(
  pool: Pool,
  mechanism: Mechanism,
  order: OrderRef,
  itemSku: string,
  quantity: number,
  simulateFailure = false,
): Promise<StepOutcome<ReservationRef>> {
  return runStep(pool, {
    orderId: order.id,
    mechanism,
    stepName: "reserveInventory",
    direction: "forward",
    simulateFailure,
    simulatedFailureMessage: `simulated failure: inventory system rejected reserving ${quantity}x ${itemSku} for order ${order.publicId}`,
    detail: { itemSku, quantity },
    work: async (client) => {
      const itemResult = await client.query<{ id: number; available_quantity: number }>(
        "SELECT id, available_quantity FROM inventory_items WHERE sku = $1 FOR UPDATE",
        [itemSku],
      );
      const item = itemResult.rows[0];
      if (!item) {
        throw new Error(`Unknown SKU "${itemSku}"`);
      }
      if (item.available_quantity < quantity) {
        throw new Error(
          `Insufficient inventory for "${itemSku}": have ${item.available_quantity}, need ${quantity}`,
        );
      }

      await client.query("UPDATE inventory_items SET available_quantity = available_quantity - $1 WHERE id = $2", [
        quantity,
        item.id,
      ]);
      const reservationResult = await client.query<{ id: number }>(
        `INSERT INTO inventory_reservations (order_id, item_id, quantity, status)
         VALUES ($1, $2, $3, 'reserved')
         RETURNING id`,
        [order.id, item.id, quantity],
      );

      return { reservationId: reservationResult.rows[0]!.id, itemId: item.id, quantity };
    },
  });
}

export async function capturePaymentStep(
  pool: Pool,
  mechanism: Mechanism,
  order: OrderRef,
  amountCents: number,
  simulateFailure = false,
): Promise<StepOutcome<PaymentRef>> {
  return runStep(pool, {
    orderId: order.id,
    mechanism,
    stepName: "capturePayment",
    direction: "forward",
    simulateFailure,
    simulatedFailureMessage: `simulated failure: payment gateway declined order ${order.publicId}`,
    detail: { amountCents },
    work: async (client) => {
      const paymentResult = await client.query<{ id: number }>(
        `INSERT INTO payments (order_id, amount_cents, status)
         VALUES ($1, $2, 'captured')
         RETURNING id`,
        [order.id, amountCents],
      );
      return { paymentId: paymentResult.rows[0]!.id };
    },
  });
}

export async function createShipmentStep(
  pool: Pool,
  mechanism: Mechanism,
  order: OrderRef,
  simulateFailure = false,
): Promise<StepOutcome<{ shipmentId: number }>> {
  return runStep(pool, {
    orderId: order.id,
    mechanism,
    stepName: "createShipment",
    direction: "forward",
    simulateFailure,
    simulatedFailureMessage: `simulated failure: carrier API rejected shipment creation for order ${order.publicId}`,
    work: async (client) => {
      const shipmentResult = await client.query<{ id: number }>(
        `INSERT INTO shipments (order_id, status)
         VALUES ($1, 'created')
         RETURNING id`,
        [order.id],
      );
      return { shipmentId: shipmentResult.rows[0]!.id };
    },
  });
}

/** The saga's final forward step: mark the order `completed` once shipment
 * creation has succeeded. Kept separate from `createShipmentStep` so both
 * mechanisms can log it as its own explicit hop - the orchestrator calls it
 * directly right after `createShipmentStep`; the choreography order-service
 * handler calls it in reaction to consuming `ShipmentCreated` (see
 * src/choreography/handlers.ts). */
export async function completeOrderStep(
  pool: Pool,
  mechanism: Mechanism,
  orderId: number,
): Promise<StepOutcome<Record<string, never>>> {
  return runStep(pool, {
    orderId,
    mechanism,
    stepName: "completeOrder",
    direction: "forward",
    work: async (client) => {
      await client.query("UPDATE orders SET status = 'completed' WHERE id = $1", [orderId]);
      return {};
    },
  });
}

export async function fetchOrderById(pool: Pool, orderId: number): Promise<OrderRef> {
  const result = await pool.query<{ id: number; public_id: string }>(
    "SELECT id, public_id FROM orders WHERE id = $1",
    [orderId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Order ${orderId} does not exist`);
  }
  return { id: row.id, publicId: row.public_id };
}
