import { Faker, en } from "@faker-js/faker";
import { generateProducts } from "@labs/data-generators";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase } from "../db/primary-client.js";
import { products } from "../db/schema.js";

const log = createLogger("lab25:seed");

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
 * Writes ONLY to the primary - the point of every lab in this replication
 * arc. Reuses the EXISTING `generateProducts` generator from
 * `@labs/data-generators` (same reuse pattern Lab 21 established for its own
 * `products` table): `name`/`category`/`unitPriceCents` carry over as
 * `name`/`category`/`priceCents`, `sku` is dropped (no column for it here).
 * `stockQuantity` is generated separately with its own seeded Faker instance
 * (offset `seed + 1000` so it never draws from the same sequence
 * `generateProducts` itself consumes) since this lab's schema needs a
 * column `generateProducts` has no opinion about.
 */
async function main() {
  const { seed, size } = parseArgs();
  const rowCount = SIZE_PRESETS[size];

  await waitForDatabase(primaryPool);

  log.info({ seed, size }, "clearing existing rows on primary");
  await primaryDb.delete(products);

  const generated = generateProducts(rowCount, seed);

  const stockFaker = new Faker({ locale: en });
  stockFaker.seed(seed + 1000);

  const rows = generated.map((p) => ({
    name: p.name,
    category: p.category,
    priceCents: p.unitPriceCents,
    stockQuantity: stockFaker.number.int({ min: 10, max: 500 }),
  }));

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await primaryDb.insert(products).values(rows.slice(i, i + BATCH_SIZE));
  }

  log.info({ seed, size, products: rows.length }, "seed complete on primary");
  await primaryPool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
