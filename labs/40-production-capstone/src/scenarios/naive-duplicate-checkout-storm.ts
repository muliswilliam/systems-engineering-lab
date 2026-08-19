import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runConcurrently } from "@labs/test-utils";
import { reserveSeat, resetSeatToAvailable } from "../seats/reserve-seat.js";
import { checkoutNaive } from "../checkout/checkout-naive.js";
import { NotificationService } from "../downstream/notification-service.js";
import { runNaiveWorker } from "../outbox/worker-naive.js";
import { newCorrelationId } from "../lib/correlation.js";

const log = createLogger("lab40:scenario:naive-storm");

/**
 * THE SYSTEM-LEVEL FAILURE, naive path.
 *
 * Story: a customer's checkout request succeeds, but their network drops the
 * response before it arrives (SPEC.md Lab 15's own motivating scenario) - so
 * their client's HTTP layer resends the SAME logical checkout. Here that is
 * modeled as 20 concurrent duplicate `checkoutNaive` calls against the SAME
 * reserved seat, all "from" the same customer.
 *
 * Two mechanisms that were each fine in isolation (SKIP LOCKED claiming
 * works correctly; the seat's own conditional-write state machine correctly
 * refuses a STRANGER's checkout) do not, TOGETHER, stop this: checkout has
 * no idempotency guard, so it creates one order + one outbox event PER
 * retry, and the outbox worker has no circuit breaker, so it retries the
 * struggling notification downstream immediately, per event, with no
 * backoff - see README "Scenario" for why neither Lab 15's own idempotency
 * lab nor Lab 37's own circuit-breaker lab needed to reproduce THIS failure,
 * since neither lab's downstream was also being hit by a duplicate-order
 * pile-up at the same time.
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const DUPLICATE_REQUESTS = 20;
  const pool = createPool({ connectionString: process.env.DATABASE_URL, max: DUPLICATE_REQUESTS + 10 });
  await waitForDatabase(pool);

  const { rows } = await pool.query<{ id: number }>("SELECT id FROM seats ORDER BY id LIMIT 1");
  const seatId = rows[0]?.id;
  if (!seatId) throw new Error("No seats found - run `pnpm seed` first");

  await resetSeatToAvailable(pool, seatId);
  const customerId = "alice@example.com";
  const reservation = await reserveSeat(pool, { seatId, customerId, holdMinutes: 10 });
  if (reservation.outcome !== "reserved") throw new Error("could not reserve scenario seat");

  const correlationId = newCorrelationId();
  log.info(
    { seatId, customerId, correlationId, duplicateRequests: DUPLICATE_REQUESTS },
    "--- 1. retry storm: 20 concurrent duplicate checkout requests, naive handler ---",
  );

  const checkoutStart = Date.now();
  const checkoutResults = await runConcurrently(DUPLICATE_REQUESTS, () =>
    checkoutNaive(pool, {
      seatId,
      customerId,
      customerEmail: customerId,
      amountCents: 9_900,
      reservationToken: reservation.reservationToken,
      correlationId,
    }),
  );
  const checkoutDurationMs = Date.now() - checkoutStart;
  const createdCount = checkoutResults.filter(
    (r) => r.status === "fulfilled" && r.value.outcome === "created",
  ).length;

  const { rows: orderCountRows } = await pool.query<{ count: string }>(
    "SELECT count(*) FROM orders WHERE seat_id = $1",
    [seatId],
  );
  const { rows: outboxCountRows } = await pool.query<{ count: string }>(
    "SELECT count(*) FROM outbox_events",
  );

  log.info(
    {
      duplicateRequests: DUPLICATE_REQUESTS,
      checkoutsCreated: createdCount,
      distinctOrdersInDb: Number(orderCountRows[0]?.count),
      outboxEventsCreated: Number(outboxCountRows[0]?.count),
      checkoutDurationMs,
    },
    "THE BUG: one logical checkout produced multiple orders and multiple outbox events",
  );

  log.info(
    "--- 2. draining the outbox with the naive worker (no timeout, no breaker) against a degraded notification downstream ---",
  );
  const notificationService = new NotificationService({ seed: 7, health: "degraded" });
  const drainStart = Date.now();
  const stats = await runNaiveWorker(pool, "naive-worker-1", notificationService, { retries: 3, maxEmptyPolls: 5 });
  const drainDurationMs = Date.now() - drainStart;

  const { rows: finalStatusRows } = await pool.query<{ status: string; count: string }>(
    "SELECT status, count(*) FROM outbox_events GROUP BY status",
  );

  log.info(
    {
      claimAttemptsPublished: stats.published,
      claimAttemptsFailed: stats.failed,
      notificationCallsMade: stats.notificationCallsMade,
      distinctCustomersActuallyNotified: notificationService.distinctKeysNotified,
      finalOutboxStatus: finalStatusRows,
      drainDurationMs,
    },
    `THE COMPOUNDING EFFECT: ${stats.notificationCallsMade} real calls were made to the struggling downstream to (attempt to) notify ONE customer ${notificationService.distinctKeysNotified} separate time(s) about what should have been a single order`,
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "naive duplicate checkout storm scenario failed");
    process.exit(1);
  });
}
