import { createLogger } from "@labs/logging";
import { generateEvents, generateSeats } from "@labs/data-generators";
import { db, pool, waitForDatabase } from "../db/client.js";
import { events, seats, orders, outboxEvents, notificationAttempts } from "../db/schema.js";
import { createRedisClient, waitForRedis } from "../redis/redis-client.js";

const log = createLogger("lab40:seed");

const DEFAULT_SEED = 42;
const SEATS_PER_EVENT = 30;

/** Section determines price band - the same "relationships must make sense" principle SPEC.md 8.3 requires for every domain (role determines salary band, seat section determines price). */
const SECTION_PRICE_CENTS: Record<string, number> = { A: 15_000, B: 9_500, C: 6_000 };

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

/**
 * Idempotent and deterministic: clears every table this lab owns and
 * reseeds one event with 30 seats every run (small dataset on purpose -
 * this lab is about composed mechanisms, not bulk data, the same scoping
 * Lab 36 documents for its own seed script). Also `FLUSHDB`s Redis so a
 * leftover token-bucket key from a previous run never changes which branch
 * the rate-limit scenario exercises.
 */
async function main() {
  const seed = Number(parseArg("seed") ?? DEFAULT_SEED);
  await waitForDatabase(pool);

  log.info("clearing notification_attempts, outbox_events, orders, seats, events");
  await db.delete(notificationAttempts);
  await db.delete(outboxEvents);
  await db.delete(orders);
  await db.delete(seats);
  await db.delete(events);

  const generatedEvents = generateEvents(1, seed);
  const insertedEvents = await db.insert(events).values(generatedEvents).returning();
  const eventRow = insertedEvents[0]!;

  const generatedSeats = generateSeats(generatedEvents, SEATS_PER_EVENT, seed);
  await db.insert(seats).values(
    generatedSeats.map((seat) => ({
      publicId: seat.publicId,
      eventId: eventRow.id,
      section: seat.section,
      seatNumber: seat.seatNumber,
      priceCents: SECTION_PRICE_CENTS[seat.section] ?? 7_500,
    })),
  );

  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is not set - copy .env.example to .env first");
  }
  const redis = createRedisClient(process.env.REDIS_URL);
  await waitForRedis(redis);
  await redis.flushdb();
  await redis.quit();

  log.info(
    { seed, eventName: eventRow.name, seatCount: generatedSeats.length },
    "seed complete: 1 event, 30 seats, Redis flushed",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
