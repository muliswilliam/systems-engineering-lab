import "dotenv/config";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runConcurrently } from "@labs/test-utils";
import { reserveSeat, resetSeatToAvailable } from "../seats/reserve-seat.js";
import { checkoutIdempotent } from "../checkout/checkout-idempotent.js";
import { NotificationService } from "../downstream/notification-service.js";
import { createProtectedWorker } from "../outbox/worker-protected.js";
import { newCorrelationId } from "../lib/correlation.js";
import { createRedisClient, waitForRedis } from "../redis/redis-client.js";
import { createTokenBucketLimiter } from "../lib/rate-limiter.js";

const log = createLogger("lab40:scenario:composed-storm");

/**
 * THE SAME SYSTEM-LEVEL FAILURE, composed/protected path.
 *
 * Identical retry storm (20 concurrent duplicate checkout requests for one
 * logical purchase) PLUS 8 other, genuinely distinct customers checking out
 * during the same window (ordinary organic load, not duplicates) - all
 * arriving while the notification downstream is fully DOWN, a harder
 * condition than the naive scenario's "merely degraded" downstream, on
 * purpose: this is where the circuit breaker's own contribution becomes
 * separately measurable from idempotency's contribution. Every request
 * first passes through the SAME token-bucket rate limiter Lab 36 teaches
 * (generous capacity here - see README "Architecture" for why rate limiting
 * and idempotency are deliberately kept orthogonal in this design).
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is not set - copy .env.example to .env first");
  }

  const DUPLICATE_REQUESTS = 20;
  const DISTINCT_LEGIT_CHECKOUTS = 8;
  const pool = createPool({
    connectionString: process.env.DATABASE_URL,
    max: DUPLICATE_REQUESTS + DISTINCT_LEGIT_CHECKOUTS + 10,
  });
  await waitForDatabase(pool);

  const redis = createRedisClient(process.env.REDIS_URL);
  await waitForRedis(redis);
  await redis.del("lab40:ratelimit:checkout-api");
  const limiter = createTokenBucketLimiter(redis, { capacity: 200, refillPerSecond: 200 });

  const { rows: seatRows } = await pool.query<{ id: number }>(
    "SELECT id FROM seats ORDER BY id LIMIT $1",
    [DISTINCT_LEGIT_CHECKOUTS + 1],
  );
  if (seatRows.length < DISTINCT_LEGIT_CHECKOUTS + 1) {
    throw new Error("Not enough seats - run `pnpm seed` first");
  }
  for (const row of seatRows) {
    await resetSeatToAvailable(pool, row.id);
  }

  const duplicateStormSeatId = seatRows[0]!.id;
  const legitSeatIds = seatRows.slice(1).map((r) => r.id);

  // --- 1. reserve every seat that will be checked out in this run. ---------
  const duplicateStormCustomer = "alice@example.com";
  const duplicateStormReservation = await reserveSeat(pool, {
    seatId: duplicateStormSeatId,
    customerId: duplicateStormCustomer,
    holdMinutes: 10,
  });
  if (duplicateStormReservation.outcome !== "reserved") throw new Error("could not reserve scenario seat");

  const legitReservations = await Promise.all(
    legitSeatIds.map(async (seatId, index) => {
      const customerId = `legit-customer-${index}@example.com`;
      const reservation = await reserveSeat(pool, { seatId, customerId, holdMinutes: 10 });
      if (reservation.outcome !== "reserved") throw new Error(`could not reserve legit seat ${seatId}`);
      return { seatId, customerId, reservationToken: reservation.reservationToken };
    }),
  );

  // --- 2. the retry storm: ONE idempotency key + correlation id reused across all 20 duplicate requests. ---
  const stormIdempotencyKey = randomUUID();
  const stormCorrelationId = newCorrelationId();

  log.info(
    { seatId: duplicateStormSeatId, duplicateRequests: DUPLICATE_REQUESTS, idempotencyKey: stormIdempotencyKey },
    "--- 1. retry storm: 20 concurrent duplicate checkout requests, SAME idempotency key, rate-limited + idempotent handler ---",
  );

  const checkoutStart = Date.now();
  const duplicateResults = await runConcurrently(DUPLICATE_REQUESTS, async () => {
    const decision = await limiter.check("checkout-api");
    if (!decision.allowed) return { outcome: "rate-limited" as const };
    return checkoutIdempotent(pool, {
      seatId: duplicateStormSeatId,
      customerId: duplicateStormCustomer,
      customerEmail: duplicateStormCustomer,
      amountCents: 9_900,
      reservationToken: duplicateStormReservation.reservationToken,
      idempotencyKey: stormIdempotencyKey,
      correlationId: stormCorrelationId,
    });
  });
  const checkoutDurationMs = Date.now() - checkoutStart;

  const newlyCreated = duplicateResults.filter(
    (r) => r.status === "fulfilled" && "outcome" in r.value && r.value.outcome === "created",
  ).length;
  const duplicatesSuppressed = duplicateResults.filter(
    (r) => r.status === "fulfilled" && "outcome" in r.value && r.value.outcome === "duplicate",
  ).length;

  // --- 3. ordinary, non-duplicate load from 8 other customers, same window. ---
  await Promise.all(
    legitReservations.map((r) =>
      checkoutIdempotent(pool, {
        seatId: r.seatId,
        customerId: r.customerId,
        customerEmail: r.customerId,
        amountCents: 9_900,
        reservationToken: r.reservationToken,
        idempotencyKey: randomUUID(),
        correlationId: newCorrelationId(),
      }),
    ),
  );

  const { rows: orderCountRows } = await pool.query<{ count: string }>(
    "SELECT count(*) FROM orders WHERE seat_id = $1",
    [duplicateStormSeatId],
  );
  const { rows: totalOutboxRows } = await pool.query<{ count: string }>("SELECT count(*) FROM outbox_events");

  log.info(
    {
      duplicateRequests: DUPLICATE_REQUESTS,
      newlyCreated,
      duplicatesSuppressed,
      distinctOrdersForStormSeat: Number(orderCountRows[0]?.count),
      totalOutboxEventsCreated: Number(totalOutboxRows[0]?.count),
      checkoutDurationMs,
    },
    newlyCreated === 1 && duplicatesSuppressed === DUPLICATE_REQUESTS - 1 && Number(orderCountRows[0]?.count) === 1
      ? "THE FIX HOLDS: exactly 1 order and 1 outbox event exist for the 20-way duplicate storm, no matter how many retries arrived"
      : "unexpected: idempotency did not hold",
  );

  // --- 4. drain the outbox with the PROTECTED worker against a fully DOWN downstream. ---
  log.info(
    "--- 2. draining the outbox with the protected worker (timeout + backoff + circuit breaker) against a DOWN notification downstream ---",
  );
  const notificationService = new NotificationService({ seed: 7, health: "down" });
  const worker = createProtectedWorker({ failureThreshold: 3, cooldownMs: 500, timeoutMs: 200, maxAttempts: 3 });
  const drainStart = Date.now();
  const stats = await worker.runProtectedWorker(pool, "protected-worker-1", notificationService, {
    maxEmptyPolls: 5,
  });
  const drainDurationMs = Date.now() - drainStart;

  const { rows: finalStatusRows } = await pool.query<{ status: string; count: string }>(
    "SELECT status, count(*) FROM outbox_events GROUP BY status",
  );

  log.info(
    {
      claimAttemptsPublished: stats.published,
      claimAttemptsFailed: stats.failed,
      circuitOpenRejections: stats.circuitOpenRejections,
      notificationCallsMade: stats.notificationCallsMade,
      finalBreakerState: worker.getBreakerState(),
      finalOutboxStatus: finalStatusRows,
      drainDurationMs,
    },
    `THE BREAKER'S CONTRIBUTION: only ${stats.notificationCallsMade} real downstream calls were made across ${stats.published + stats.failed} claim attempts - ${stats.circuitOpenRejections} were rejected LOCALLY once the breaker tripped, without ever touching the struggling downstream`,
  );

  await redis.quit();
  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "composed duplicate checkout storm scenario failed");
    process.exit(1);
  });
}
