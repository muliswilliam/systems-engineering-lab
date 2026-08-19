import { generateEvents, generateSeats } from "@labs/data-generators";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { events, seats } from "../db/schema.js";

const log = createLogger("lab12:seed");

type Size = "small" | "medium" | "large";

const SIZE_PRESETS: Record<Size, { events: number; seatsPerEvent: number }> = {
  small: { events: 3, seatsPerEvent: 30 },
  medium: { events: 8, seatsPerEvent: 100 },
  large: { events: 20, seatsPerEvent: 300 },
};

function parseArgs(): { seed: number; size: Size } {
  const args = process.argv.slice(2);
  const seedArg = args.find((a) => a.startsWith("--seed="));
  const sizeArg = args.find((a) => a.startsWith("--size="));
  const seed = seedArg ? Number(seedArg.split("=")[1]) : 42;
  const size = (sizeArg ? sizeArg.split("=")[1] : "small") as Size;

  if (!(size in SIZE_PRESETS)) {
    throw new Error(`Unknown --size "${size}". Use small, medium, or large.`);
  }

  return { seed, size };
}

const BATCH_SIZE = 500;

/**
 * Idempotent: clears both tables (seats first, since it references events)
 * and reinserts a fresh, deterministic set of events/seats every run - every
 * seat starts `AVAILABLE` with no reservation, so running this twice with
 * the same flags produces the same logical dataset (SPEC.md 8.1). The
 * scenario scripts and concurrency tests then reserve/expire/sell seats on
 * top of this baseline.
 */
async function main() {
  const { seed, size } = parseArgs();
  const preset = SIZE_PRESETS[size];

  await waitForDatabase(pool);

  log.info({ seed, size }, "clearing existing rows");
  await db.delete(seats);
  await db.delete(events);

  const generatedEvents = generateEvents(preset.events, seed);
  const insertedEvents = await db
    .insert(events)
    .values(
      generatedEvents.map((e) => ({
        publicId: e.publicId,
        name: e.name,
        venueName: e.venueName,
        eventAt: e.eventAt,
      })),
    )
    .returning({ id: events.id });

  const generatedSeats = generateSeats(generatedEvents, preset.seatsPerEvent, seed);
  const seatRows = generatedSeats.map((s) => ({
    publicId: s.publicId,
    eventId: insertedEvents[s.eventIndex]!.id,
    section: s.section,
    row: s.row,
    seatNumber: s.seatNumber,
  }));

  for (let i = 0; i < seatRows.length; i += BATCH_SIZE) {
    await db.insert(seats).values(seatRows.slice(i, i + BATCH_SIZE));
  }

  log.info({ events: insertedEvents.length, seats: seatRows.length }, "seed complete");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
