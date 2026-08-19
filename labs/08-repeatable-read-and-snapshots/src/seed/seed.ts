import { faker } from "@faker-js/faker";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { accounts, onCallStaff } from "../db/schema.js";
import { SCENARIO_ACCOUNTS, SCENARIO_STAFF } from "./scenario-data.js";

const log = createLogger("lab08:seed");

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
  await db.delete(onCallStaff);

  faker.seed(seed);

  const browsingAccounts = Array.from({ length: browsingAccountCount }, (_, i) => ({
    // Suffix guarantees uniqueness under the `name` unique constraint even
    // though faker.seed() makes account names repeat once you exceed
    // faker's pool of finance account names.
    name: `${faker.finance.accountName()} #${i + 1}`,
    balanceCents: faker.number.int({ min: 10_000, max: 10_000_000 }),
  }));

  // A handful of extra "browsing" on-call staff so the scenario rows are not
  // the only rows in the table - same rationale as the browsing accounts.
  const browsingStaff = Array.from({ length: Math.min(browsingAccountCount, 10) }, (_, i) => ({
    name: `Dr. ${faker.person.lastName()} #${i + 1}`,
    isOnCall: faker.datatype.boolean(),
  }));

  await db.insert(accounts).values([...SCENARIO_ACCOUNTS, ...browsingAccounts]);
  await db.insert(onCallStaff).values([...SCENARIO_STAFF, ...browsingStaff]);

  log.info(
    {
      scenarioAccounts: SCENARIO_ACCOUNTS.length,
      browsingAccounts: browsingAccounts.length,
      scenarioStaff: SCENARIO_STAFF.length,
      browsingStaff: browsingStaff.length,
    },
    "seed complete",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
