import type { Pool } from "pg";
import type { ClaimedEvent } from "./claim.js";

/**
 * A pure observability write (schema.ts's `notification_attempts` table) -
 * nothing downstream reads this to decide behavior. It exists so the
 * composed scenarios/tests can reconstruct, after the fact, exactly how many
 * times the system tried to notify the customer for each order and what the
 * circuit breaker's state was at each attempt - the "operator's-eye view of
 * the incident and recovery" this lab's brief asks for.
 */
export async function recordNotificationAttempt(
  pool: Pool,
  event: ClaimedEvent,
  outcome: "success" | "failure" | "circuit_open",
  latencyMs: number,
  breakerState: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO notification_attempts (order_public_id, correlation_id, outcome, breaker_state, latency_ms)
     VALUES ($1, $2, $3, $4, $5)`,
    [event.payload.orderPublicId, event.payload.correlationId, outcome, breakerState, Math.round(latencyMs)],
  );
}
