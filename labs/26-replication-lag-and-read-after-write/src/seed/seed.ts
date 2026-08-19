import { Faker, en } from "@faker-js/faker";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase } from "../db/primary-client.js";
import { userProfiles } from "../db/schema.js";

const log = createLogger("lab26:seed");

type Size = "small" | "medium" | "large";

// `user_profiles` is a deliberately minimal, scenario-specific table (see
// schema.ts) - not one of SPEC.md section 8.2's five named domains, same
// "small standalone table, the lesson is the mechanism" rationale as Lab
// 06's `counters`/Lab 24's `widgets`. No generator was added to
// @labs/data-generators for the same reason Labs 16/19/23 called faker
// directly in their own seed scripts.
const SIZE_PRESETS: Record<Size, number> = {
  small: 30,
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
 * Writes ONLY to the primary, idempotently (delete-then-reinsert, same
 * convention as every other lab's seed script). Every scenario in this lab
 * subsequently UPDATEs these seeded rows' `display_name` - the seed script
 * just needs to guarantee a known, deterministic starting population exists.
 */
async function main() {
  const { seed, size } = parseArgs();
  const rowCount = SIZE_PRESETS[size];

  await waitForDatabase(primaryPool);

  log.info({ seed, size }, "clearing existing rows on primary");
  await primaryDb.delete(userProfiles);

  const faker = new Faker({ locale: en });
  faker.seed(seed);

  const rows = Array.from({ length: rowCount }, (_, i) => ({
    displayName: `${faker.person.firstName()} ${faker.person.lastName()} (seed #${i + 1})`,
    bio: faker.lorem.sentence(),
  }));

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await primaryDb.insert(userProfiles).values(rows.slice(i, i + BATCH_SIZE));
  }

  log.info({ seed, size, profiles: rows.length }, "seed complete on primary");
  await primaryPool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
