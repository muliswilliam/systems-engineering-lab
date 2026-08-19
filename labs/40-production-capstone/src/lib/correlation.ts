import { randomUUID } from "node:crypto";

/**
 * One correlation id per logical checkout REQUEST, generated once by the
 * client-side caller before the first attempt and reused across every retry
 * of that same logical request - exactly parallel to how an idempotency key
 * is generated once and reused (src/checkout/checkout-idempotent.ts), but
 * this id's job is tracing/observability, not correctness. It is threaded
 * through: the checkout log line, the order row, the outbox event's own
 * payload, the worker's claim/publish log lines, and the notification
 * attempt log - so `grep correlationId` (or a PGweb filter on
 * `notification_attempts.correlation_id` / `orders.correlation_id`) recovers
 * the whole story for one customer's checkout, per SPEC.md Lab 38's "trace
 * one request across API -> database -> outbox -> publisher -> consumer".
 */
export function newCorrelationId(): string {
  return `corr_${randomUUID()}`;
}
