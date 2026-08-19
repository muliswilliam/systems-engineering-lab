import { faker } from "@faker-js/faker";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { accounts } from "../db/schema.js";
import { SCENARIO_ACCOUNTS } from "./scenario-accounts.js";

const log = createLogger("lab10:seed");

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

async function main() {
  const { seed, size } = parseArgs();
  const browsingAccountCount = SIZE_PRESETS[size];

  await waitForDatabase(pool);

  log.info({ seed, size }, "clearing existing rows");
  await db.delete(accounts);

  faker.seed(seed);

  const browsingAccounts = Array.from({ length: browsingAccountCount }, (_, i) => ({
    // Suffix guarantees every row is distinct even though this seed does not
    // enforce a unique constraint on owner_name (unlike the scenario rows,
    // which are looked up by name and must stay unambiguous).
    ownerName: `${faker.person.fullName()} #${i + 1}`,
    balanceCents: faker.number.int({ min: 10_000, max: 10_000_000 }),
  }));

  await db.insert(accounts).values([...SCENARIO_ACCOUNTS, ...browsingAccounts]);

  log.info(
    { scenarioAccounts: SCENARIO_ACCOUNTS.length, browsingAccounts: browsingAccounts.length },
    "seed complete",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
