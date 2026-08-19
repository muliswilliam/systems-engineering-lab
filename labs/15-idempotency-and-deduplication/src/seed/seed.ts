import { randomUUID } from "node:crypto";
import { Faker, en } from "@faker-js/faker";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { payments } from "../db/schema.js";

const log = createLogger("lab15:seed");

type Size = "small" | "medium" | "large";

const SIZE_PRESETS: Record<Size, number> = {
  small: 20,
  medium: 200,
  large: 2_000,
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
 * Seeds a baseline of already-settled, correctly-idempotent historical
 * payments - one real, distinct `idempotency_key` per row, exactly what a
 * healthy production `payments` table looks like. This is scenery for PGweb
 * and a sanity dataset for `pnpm dev`; it is NOT what demonstrates the bug or
 * the fix - that only happens when you run the scenario scripts (or the
 * tests), which insert their own rows using their own idempotency-key
 * discipline (or lack of it).
 *
 * Idempotent and deterministic per SPEC.md 8.1: clears the table first, then
 * reinserts the same logical dataset for a given `--seed`. The historical
 * rows' `idempotency_key` values are randomly generated (`randomUUID()`, not
 * derived from the faker seed) since a real idempotency key is a
 * client-generated opaque token, not domain data - only `payee`/`amountCents`
 * need to be deterministic here for the dataset to be reproducible in spirit.
 */
async function main() {
  const { seed, size } = parseArgs();
  const rowCount = SIZE_PRESETS[size];

  await waitForDatabase(pool);

  log.info({ seed, size, rowCount }, "clearing existing rows");
  await db.delete(payments);

  const faker = new Faker({ locale: en });
  faker.seed(seed);

  const rows = Array.from({ length: rowCount }, () => ({
    idempotencyKey: randomUUID(),
    amountCents: faker.number.int({ min: 500, max: 250_000 }),
    payee: faker.company.name(),
    status: "completed" as const,
    confirmationCode: randomUUID().slice(0, 8).toUpperCase(),
    processingFeeCents: faker.number.int({ min: 45, max: 7_250 }),
  }));

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await db.insert(payments).values(rows.slice(i, i + BATCH_SIZE));
  }

  log.info({ seed, size, inserted: rows.length }, "seed complete");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
