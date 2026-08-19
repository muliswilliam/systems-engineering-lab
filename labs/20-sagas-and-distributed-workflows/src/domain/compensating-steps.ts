import type { Pool } from "pg";
import { runStep } from "./run-step.js";
import type { Mechanism, PaymentRef, ReservationRef, StepOutcome } from "./types.js";

/**
 * The three compensating actions, one per forward step that can leave
 * durable state behind (`createShipment` has none - see README
 * "Architecture"). Mechanism-agnostic, exactly like `src/domain/steps.ts`:
 * the orchestrator calls these directly, in reverse order, from its own
 * `catch` handling; the choreography handlers call the identical functions
 * in reaction to a `*Failed`/`*Refunded`/`*Released` event.
 *
 * None of these three support `simulateFailure` - this lab's scope (per
 * SPEC.md) is a failure *after payment*, not a failure *during
 * compensation*. A compensation that can itself fail is a real, harder
 * problem (see README "Further experiments" and "Production notes").
 */

export async function refundPaymentStep(
  pool: Pool,
  mechanism: Mechanism,
  orderId: number,
  payment: PaymentRef,
): Promise<StepOutcome<Record<string, never>>> {
  return runStep(pool, {
    orderId,
    mechanism,
    stepName: "refundPayment",
    direction: "compensate",
    detail: { paymentId: payment.paymentId },
    work: async (client) => {
      await client.query("UPDATE payments SET status = 'refunded' WHERE id = $1", [payment.paymentId]);
      return {};
    },
  });
}

export async function releaseInventoryStep(
  pool: Pool,
  mechanism: Mechanism,
  orderId: number,
  reservation: ReservationRef,
): Promise<StepOutcome<Record<string, never>>> {
  return runStep(pool, {
    orderId,
    mechanism,
    stepName: "releaseInventory",
    direction: "compensate",
    detail: { ...reservation },
    work: async (client) => {
      await client.query("UPDATE inventory_items SET available_quantity = available_quantity + $1 WHERE id = $2", [
        reservation.quantity,
        reservation.itemId,
      ]);
      await client.query("UPDATE inventory_reservations SET status = 'released' WHERE id = $1", [
        reservation.reservationId,
      ]);
      return {};
    },
  });
}

export async function cancelOrderStep(
  pool: Pool,
  mechanism: Mechanism,
  orderId: number,
): Promise<StepOutcome<Record<string, never>>> {
  return runStep(pool, {
    orderId,
    mechanism,
    stepName: "cancelOrder",
    direction: "compensate",
    work: async (client) => {
      await client.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [orderId]);
      return {};
    },
  });
}
