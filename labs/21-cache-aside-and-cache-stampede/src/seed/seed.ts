import { generateProducts } from "@labs/data-generators";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { products } from "../db/schema.js";
import { createRedisClient, waitForRedis } from "../cache/redis-client.js";

const log = createLogger("lab21:seed");

type Size = "small" | "medium" | "large";

const SIZE_PRESETS: Record<Size, { products: number }> = {
  small: { products: 20 },
  medium: { products: 200 },
  large: { products: 2_000 },
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
 * Reuses `@labs/data-generators`'s commerce `generateProducts` (SPEC.md's
 * commerce domain already has a product generator) rather than adding a new
 * one - this lab's `products` table is deliberately narrower than
 * `GeneratedProduct` (no `sku`/`category` columns, see README.md
 * "Architecture" for why), so only `name` and `unitPriceCents` are carried
 * over.
 *
 * Idempotent and deterministic like every other lab's seed script: clears
 * `products` and reinserts a fresh, seeded set every run. It ALSO flushes
 * Redis (`FLUSHDB`) every run, which matters more here than in most labs -
 * this lab's entire point is cache state (cold vs warm keys, leases,
 * stale-while-revalidate entries, jitter demo keys), and a stale key left
 * over from a previous run/scenario would silently change which code path a
 * scenario or test exercises.
 */
async function main() {
  const { seed, size } = parseArgs();
  const preset = SIZE_PRESETS[size];

  await waitForDatabase(pool);

  log.info({ seed, size }, "clearing existing rows");
  await db.delete(products);

  const generatedProducts = generateProducts(preset.products, seed);
  const insertedProducts = await db
    .insert(products)
    .values(
      generatedProducts.map((p) => ({
        publicId: p.publicId,
        name: p.name,
        priceCents: p.unitPriceCents,
      })),
    )
    .returning({ id: products.id });

  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is not set - copy .env.example to .env first");
  }
  const redis = createRedisClient(process.env.REDIS_URL);
  await waitForRedis(redis);
  await redis.flushdb();
  await redis.quit();

  log.info({ products: insertedProducts.length }, "seed complete (products inserted, Redis flushed)");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
