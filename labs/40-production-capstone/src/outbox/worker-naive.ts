import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { metrics } from "../lib/metrics.js";
import type { NotificationService } from "../downstream/notification-service.js";
import { retryImmediatelyNoBackoff } from "../lib/retry.js";
import { claimNextEvent, markPublished, markPublishFailed } from "./claim.js";
import { recordNotificationAttempt } from "./notification-log.js";

const log = createLogger("lab40:outbox:worker-naive");

export interface NaiveWorkerStats {
  /** Number of individual CLAIMS that ended in a successful publish (a reclaimed-then-retried event is counted once per claim, not once per event). */
  published: number;
  /** Number of individual CLAIMS that failed and (if under max_attempts) went back to `pending` for reclaim - NOT the count of permanently-failed events. Query `outbox_events.status` for the terminal, event-level truth. */
  failed: number;
  notificationCallsMade: number;
}

/**
 * THE BUG, part 2.
 *
 * A realistic-looking outbox publisher: it claims via `SKIP LOCKED` (so
 * concurrent publishers still never double-claim a row - Lab 14/17's
 * mechanism is intact here), then calls the notification downstream with a
 * FIXED number of immediate retries and NO timeout and NO circuit breaker -
 * Lab 37's "naive retry storm" anti-pattern, reused fresh, now composed
 * against a REAL degraded downstream in a real pipeline rather than a
 * synthetic one-off call.
 *
 * Two failure modes stack on top of each other here, and NEITHER exists in
 * isolation in any earlier lab:
 *
 *   1. If checkout duplicated N orders for one logical purchase (see
 *      checkout-naive.ts), this worker faithfully tries to notify the
 *      customer N separate times - a duplicate BUSINESS communication, not
 *      just wasted backend work.
 *   2. Every one of those N notification attempts, with no breaker, retries
 *      immediately against a downstream that is already struggling - each
 *      claimed event can cost up to `retries` real calls, all in the same
 *      short window, which is exactly how one already-bad situation (a
 *      degraded downstream) becomes a much worse one (a downstream that
 *      never gets a chance to recover because retries keep arriving at full
 *      volume) - see README "Scenario".
 */
export async function runNaiveWorker(
  pool: Pool,
  workerId: string,
  notificationService: NotificationService,
  opts: { retries?: number; maxEmptyPolls?: number } = {},
): Promise<NaiveWorkerStats> {
  const retries = opts.retries ?? 3;
  const maxEmptyPolls = opts.maxEmptyPolls ?? 3;
  const stats: NaiveWorkerStats = { published: 0, failed: 0, notificationCallsMade: 0 };
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
      await retryImmediatelyNoBackoff(() => notificationService.send(dedupeKey), retries);
      const latencyMs = Date.now() - start;
      stats.notificationCallsMade += notificationService.totalCallCount - callsBefore;
      await recordNotificationAttempt(pool, event, "success", latencyMs, "n/a");
      await markPublished(pool, event.id, workerId);
      metrics.incrementCounter("capstone_outbox_published_total", { worker: "naive" });
      stats.published += 1;
      workerLog.info({ eventId: event.id, dedupeKey, latencyMs }, "naive worker published (no breaker)");
    } catch (error) {
      const latencyMs = Date.now() - start;
      stats.notificationCallsMade += notificationService.totalCallCount - callsBefore;
      await recordNotificationAttempt(pool, event, "failure", latencyMs, "n/a");
      await markPublishFailed(pool, event.id, workerId);
      metrics.incrementCounter("capstone_outbox_failed_total", { worker: "naive" });
      stats.failed += 1;
      workerLog.error(
        { err: error, eventId: event.id, dedupeKey, latencyMs },
        "naive worker gave up after immediate retries with no backoff",
      );
    }
  }

  return stats;
}
