import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { metrics } from "../lib/metrics.js";
import type { NotificationService } from "../downstream/notification-service.js";
import { retryWithBackoff } from "../lib/retry.js";
import { withTimeout, TimeoutError } from "../lib/timeout.js";
import { CircuitBreaker, CircuitOpenError } from "../lib/circuit-breaker.js";
import { TransientNotificationError } from "../downstream/notification-service.js";
import { claimNextEvent, markPublished, markPublishFailed } from "./claim.js";
import { recordNotificationAttempt } from "./notification-log.js";

const log = createLogger("lab40:outbox:worker-protected");

export interface ProtectedWorkerStats {
  /** Number of individual CLAIMS that ended in a successful publish (a reclaimed-then-retried event is counted once per claim, not once per event). */
  published: number;
  /** Number of individual CLAIMS that failed (retries-exhausted or circuit-open) and, if under max_attempts, went back to `pending` for reclaim - NOT the count of permanently-failed events. */
  failed: number;
  circuitOpenRejections: number;
  notificationCallsMade: number;
}

/**
 * THE FIX, part 2 of 2.
 *
 * Same `SKIP LOCKED` claim as the naive worker (unchanged - the claiming
 * mechanism was never the problem), but the notification call is wrapped in
 * all three of Lab 37's mechanisms, layered in the order that lab's own
 * README argues for: circuit breaker OUTERMOST, bounded exponential backoff
 * with jitter INSIDE `breaker.execute()`, and a per-attempt timeout INSIDE
 * each retry attempt. This is what stops a struggling downstream from
 * turning into a downed one: once `failureThreshold` consecutive failures
 * trip the breaker, every further claimed event fails FAST (no downstream
 * call at all, `outcome: "circuit_open"`) until the cooldown elapses and a
 * single HALF_OPEN probe is allowed through.
 *
 * Composed with the idempotent checkout (checkout-idempotent.ts), this
 * worker's own protection only ever has to matter for ONE real notification
 * per logical order, not N - see README "Why the fix works" for why fixing
 * only one side (either idempotency or the breaker) still leaves a real
 * problem, and only fixing both closes the loop this capstone's failure
 * scenario is built around.
 */
export function createProtectedWorker(opts: {
  failureThreshold?: number;
  cooldownMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}) {
  const breaker = new CircuitBreaker({
    failureThreshold: opts.failureThreshold ?? 3,
    cooldownMs: opts.cooldownMs ?? 500,
    onStateChange: (from, to, info) => {
      log.warn({ from, to, ...info }, "circuit breaker state change");
      if (to === "OPEN") metrics.incrementCounter("capstone_circuit_breaker_open_total");
    },
  });

  const timeoutMs = opts.timeoutMs ?? 200;
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 40;
  const maxDelayMs = opts.maxDelayMs ?? 300;

  async function sendProtected(notificationService: NotificationService, dedupeKey: string): Promise<void> {
    await breaker.execute(() =>
      retryWithBackoff(() => withTimeout(() => notificationService.send(dedupeKey), timeoutMs), {
        maxAttempts,
        baseDelayMs,
        maxDelayMs,
        isRetryable: (err) => err instanceof TransientNotificationError || err instanceof TimeoutError,
      }),
    );
  }

  async function runProtectedWorker(
    pool: Pool,
    workerId: string,
    notificationService: NotificationService,
    runOpts: { maxEmptyPolls?: number } = {},
  ): Promise<ProtectedWorkerStats> {
    const maxEmptyPolls = runOpts.maxEmptyPolls ?? 3;
    const stats: ProtectedWorkerStats = {
      published: 0,
      failed: 0,
      circuitOpenRejections: 0,
      notificationCallsMade: 0,
    };
    const workerLog = log.child({ workerId });
    let emptyPolls = 0;

    while (emptyPolls < maxEmptyPolls) {
      const event = await claimNextEvent(pool, workerId);
      if (!event) {
        emptyPolls += 1;
        continue;
      }
      emptyPolls = 0;

      const dedupeKey = event.payload.orderPublicId;
      const start = Date.now();
      const callsBefore = notificationService.totalCallCount;
      try {
        await sendProtected(notificationService, dedupeKey);
        const latencyMs = Date.now() - start;
        stats.notificationCallsMade += notificationService.totalCallCount - callsBefore;
        await recordNotificationAttempt(pool, event, "success", latencyMs, breaker.getState());
        await markPublished(pool, event.id, workerId);
        metrics.incrementCounter("capstone_outbox_published_total", { worker: "protected" });
        stats.published += 1;
        workerLog.info({ eventId: event.id, dedupeKey, latencyMs }, "protected worker published");
      } catch (error) {
        const latencyMs = Date.now() - start;
        stats.notificationCallsMade += notificationService.totalCallCount - callsBefore;
        const circuitOpen = error instanceof CircuitOpenError;
        await recordNotificationAttempt(
          pool,
          event,
          circuitOpen ? "circuit_open" : "failure",
          latencyMs,
          breaker.getState(),
        );
        await markPublishFailed(pool, event.id, workerId);
        metrics.incrementCounter("capstone_outbox_failed_total", { worker: "protected" });
        stats.failed += 1;
        if (circuitOpen) stats.circuitOpenRejections += 1;
        workerLog.error(
          { err: error, eventId: event.id, dedupeKey, latencyMs, breakerState: breaker.getState() },
          circuitOpen ? "protected worker: circuit open, rejected without calling downstream" : "protected worker: retries exhausted",
        );
      }
    }

    return stats;
  }

  return { runProtectedWorker, getBreakerState: () => breaker.getState() };
}
