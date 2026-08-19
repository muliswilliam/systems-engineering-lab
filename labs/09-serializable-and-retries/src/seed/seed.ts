import { faker } from "@faker-js/faker";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { onCallStaff } from "../db/schema.js";
import { SCENARIO_STAFF } from "./scenario-staff.js";

const log = createLogger("lab09:seed");

type Size = "small" | "medium" | "large";

// Extra "browsing" staff on unrelated teams, purely so the table isn't just
// the fixed scenario rows and PGweb shows something resembling a real
// multi-team rota. None of these teams are ever touched by a scenario or test.
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
  const browsingStaffCount = SIZE_PRESETS[size];

  await waitForDatabase(pool);

  log.info({ seed, size }, "clearing existing rows");
  await db.delete(onCallStaff);

  faker.seed(seed);

  const browsingTeams = ["Radiology - Day Shift", "Pediatrics - Weekend"];
  const browsingStaff = Array.from({ length: browsingStaffCount }, (_, i) => ({
    team: browsingTeams[i % browsingTeams.length]!,
    // Suffix guarantees uniqueness under the `name` unique constraint even
    // though faker.seed() makes generated names repeat once you exceed
    // faker's pool at larger sizes.
    name: `Dr. ${faker.person.lastName()} #${i + 1}`,
    isOnCall: faker.datatype.boolean(),
  }));

  await db.insert(onCallStaff).values([
    ...SCENARIO_STAFF.map((s) => ({ ...s, isOnCall: true })),
    ...browsingStaff,
  ]);

  log.info(
    { scenarioStaff: SCENARIO_STAFF.length, browsingStaff: browsingStaff.length },
    "seed complete",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
