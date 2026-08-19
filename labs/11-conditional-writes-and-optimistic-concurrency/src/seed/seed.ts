import { faker } from "@faker-js/faker";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { documents } from "../db/schema.js";
import { SCENARIO_DOCUMENTS } from "./scenario-documents.js";

const log = createLogger("lab11:seed");

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
  const browsingDocumentCount = SIZE_PRESETS[size];

  await waitForDatabase(pool);

  log.info({ seed, size }, "clearing existing rows");
  await db.delete(documents);

  faker.seed(seed);

  const browsingDocuments = Array.from({ length: browsingDocumentCount }, (_, i) => ({
    // Suffix guarantees uniqueness under the `title` unique constraint even
    // though faker.seed() makes generated titles repeat once you exceed
    // faker's pool of catch phrases.
    title: `${faker.company.catchPhrase()} - Wiki Page #${i + 1}`,
    body: faker.lorem.paragraphs({ min: 2, max: 4 }, "\n\n"),
    status: faker.helpers.arrayElement(["draft", "published"] as const),
  }));

  await db.insert(documents).values([...SCENARIO_DOCUMENTS, ...browsingDocuments]);

  log.info(
    { scenarioDocuments: SCENARIO_DOCUMENTS.length, browsingDocuments: browsingDocuments.length },
    "seed complete",
  );
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
