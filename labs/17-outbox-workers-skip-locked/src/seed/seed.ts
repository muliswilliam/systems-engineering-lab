import { generateOutboxEvents } from "@labs/data-generators";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { outboxEvents, processedEvents } from "../db/schema.js";

const log = createLogger("lab17:seed");

type Size = "small" | "medium" | "large";

const SIZE_PRESETS: Record<Size, number> = {
  small: 30,
  medium: 300,
  large: 3_000,
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
 * Idempotent: clears both tables and reinserts a fresh, deterministic set of
 * `pending` outbox events every run (SPEC.md 8.1 - same `--seed` always
 * produces the same logical dataset). `processed_events` starts empty every
 * time; it is populated only by running the idempotent-consumer-preview
 * scenario or the test suite.
 *
 * Every seeded row starts at `status = 'pending'` - this lab models the
 * events as if some other, already-correct process had already written them
 * (see src/db/schema.ts's top comment); nothing here simulates the write
 * side itself.
 */
async function main() {
  const { seed, size } = parseArgs();
  const eventCount = SIZE_PRESETS[size];

  await waitForDatabase(pool);

  log.info({ seed, size, eventCount }, "clearing existing rows");
  await db.delete(processedEvents);
  await db.delete(outboxEvents);

  const generatedEvents = generateOutboxEvents(eventCount, seed);
  const rows = generatedEvents.map((e) => ({
    publicId: e.publicId,
    eventType: e.eventType,
    payload: e.payload,
    status: "pending" as const,
  }));

  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await db.insert(outboxEvents).values(batch);
    inserted += batch.length;
  }

  log.info({ seed, size, eventCount: inserted }, "seed complete");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
