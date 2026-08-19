import { Faker, en } from "@faker-js/faker";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { resourceState } from "../db/schema.js";
import { createRedisClient, waitForRedis } from "../redis-lock/redis-client.js";
import { fencingCounterKeyFor, lockKeyFor } from "../redis-lock/support.js";
import { SCENARIO_RESOURCES } from "./scenario-resources.js";

const log = createLogger("lab22:seed");

type Size = "small" | "medium" | "large";

const SIZE_PRESETS: Record<Size, number> = {
  small: 5,
  medium: 20,
  large: 100,
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

/**
 * Idempotent: deletes and reinserts every resource_state row (fixed scenario
 * rows plus faker-generated "browsing" rows), AND resets the Redis state
 * every scenario depends on being clean - the lock key and fencing counter
 * key for each fixed scenario resource. Without the Redis reset, a leftover
 * fencing counter from a previous run would hand out fencing tokens that no
 * longer start below the value already recorded on a freshly-reinserted
 * row, changing which outcome (stale-write-rejected vs. accepted) a rerun
 * actually reproduces.
 */
async function main() {
  const { seed, size } = parseArgs();
  const browsingCount = SIZE_PRESETS[size];

  await waitForDatabase(pool);
  const redis = createRedisClient();
  await waitForRedis(redis);

  log.info({ seed, size }, "clearing existing resource_state rows");
  await db.delete(resourceState);

  const insertedScenarioResources = await db
    .insert(resourceState)
    .values(SCENARIO_RESOURCES.map((name) => ({ name, fencingToken: 0, lastWriter: null })))
    .returning({ id: resourceState.id, name: resourceState.name });

  log.info(
    { scenarioResources: insertedScenarioResources },
    "seeded fixed scenario resources (looked up by name from scenario scripts/tests)",
  );

  const redisKeysToDelete = SCENARIO_RESOURCES.flatMap((name) => [lockKeyFor(name), fencingCounterKeyFor(name)]);
  await redis.del(...redisKeysToDelete);
  log.info({ redisKeysDeleted: redisKeysToDelete }, "reset Redis lock/fencing-counter keys for every scenario resource");

  // Realistic "browsing" resources purely so PGweb isn't just two rows - a
  // plausible shared-config/coordination domain (feature flags, pricing
  // tiers, inventory locks, scheduled report jobs), not SPEC.md's five named
  // domains, since the concept this lab teaches is the lock mechanism
  // itself, not a rich relational model - same rationale as Lab 06's
  // `counters` and Lab 11's `documents`.
  const faker = new Faker({ locale: en });
  faker.seed(seed);
  const categories = ["config", "feature-flag", "pricing-tier", "inventory-lock", "report-job"] as const;
  const browsingNames = new Set<string>();
  while (browsingNames.size < browsingCount) {
    const category = faker.helpers.arrayElement(categories);
    const noun = faker.hacker.noun();
    const suffix = faker.number.int({ min: 1, max: 999 });
    browsingNames.add(`${category}:${noun}-${suffix}`);
  }

  await db.insert(resourceState).values(Array.from(browsingNames).map((name) => ({ name })));

  log.info(
    { seed, size, scenarioResources: insertedScenarioResources.length, browsingResources: browsingNames.size },
    "seed complete",
  );

  redis.disconnect();
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
