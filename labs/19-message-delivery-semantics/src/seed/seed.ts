import { Faker, en } from "@faker-js/faker";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { deliveryLog, notifications, processedMessageIds } from "../db/schema.js";
import {
  runAtMostOnceClean,
  runAtMostOnceLost,
} from "../scenarios/at-most-once.js";
import { runAckLoss, runMessageLossThenSuccess } from "../scenarios/at-least-once.js";
import { runEffectivelyOnce } from "../scenarios/effectively-once.js";

const log = createLogger("lab19:seed");

type Size = "small" | "medium" | "large";

/** How many independent instances of EACH of the five scenario cases to
 * seed. Every instance is a fully independent message (its own recipient,
 * its own delivery_log rows) - this is not a bulk relational dataset like
 * Lab 04's, it is "how many times do you want to watch the same
 * deterministic experiment run," which is why even --size=large stays small
 * in absolute row count. */
const SIZE_PRESETS: Record<Size, number> = {
  small: 1,
  medium: 5,
  large: 20,
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
 * This lab's own generator, kept local rather than added to
 * `@labs/data-generators` (same reasoning as Lab 16's seed.ts): `notifications`
 * is a deliberately minimal, scenario-specific table, not a reusable SPEC.md
 * 8.2 domain entity, so a shared generator would be speculative machinery
 * ahead of any second consumer needing it.
 *
 * Idempotent: clears all three tables (delivery_log and
 * processed_message_ids first, since both reference notifications) and then
 * RUNS the three scenario mechanisms themselves - not just inserts rows -
 * `instancesPerScenario` times each, so `pnpm seed` always leaves the
 * database in the exact same, fully-executed state described in this lab's
 * README, ready for `pnpm dev`, PGweb inspection, or `pnpm test` to build on.
 */
async function main() {
  const { seed, size } = parseArgs();
  const instancesPerScenario = SIZE_PRESETS[size];

  await waitForDatabase(pool);

  log.info({ seed, size, instancesPerScenario }, "clearing existing rows");
  await db.delete(deliveryLog);
  await db.delete(processedMessageIds);
  await db.delete(notifications);

  const faker = new Faker({ locale: en });
  faker.seed(seed);

  let totalMessages = 0;

  for (let i = 0; i < instancesPerScenario; i += 1) {
    const marker = `${seed}-${i}-${faker.string.alphanumeric(6)}`;

    await runAtMostOnceLost(pool, `lost-${marker}@example.com`);
    await runAtMostOnceClean(pool, `clean-${marker}@example.com`);
    await runMessageLossThenSuccess(pool, `msgloss-${marker}@example.com`);
    await runAckLoss(pool, `ackloss-${marker}@example.com`);
    await runEffectivelyOnce(pool, `effonce-${marker}@example.com`);

    totalMessages += 5;
  }

  log.info(
    { seed, size, instancesPerScenario, totalMessages },
    "seed complete - every scenario case has been fully executed, not just inserted",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
