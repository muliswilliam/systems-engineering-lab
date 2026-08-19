import type { Redis } from "ioredis";
import type { Product } from "../db/product-repository.js";
import { productCacheKey } from "./cache-key.js";

export interface NaiveCacheOptions {
  ttlSeconds?: number;
}

/**
 * THE NAIVE (BROKEN) CACHE-ASIDE PATTERN.
 *
 * GET the key, on miss call the slow database read, SET with a TTL, return.
 * This is correct for a single caller - but every concurrent caller runs the
 * exact same three steps independently. If N callers all hit `getProduct`
 * while the key is missing, all N of them see a miss (Redis has nothing to
 * return yet, no matter how many callers ask), so all N of them call the
 * slow database function, and all N of them separately write the result back
 * to Redis. This is the cache stampede: the cache is supposed to shield the
 * database from repeated reads, but on a cold key it does the opposite -
 * every concurrent reader falls straight through to the database.
 *
 * See src/cache/request-coalescing.ts and src/cache/lease-based-refill.ts
 * for two different fixes, and README.md "Break it" for the real measured
 * stampede size.
 */
export function createNaiveCache(
  redis: Redis,
  getProductFromDatabase: (productId: number) => Promise<Product>,
  options: NaiveCacheOptions = {},
) {
  const ttlSeconds = options.ttlSeconds ?? 30;

  async function getProduct(productId: number): Promise<Product> {
    const key = productCacheKey(productId);

    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached) as Product;
    }

    // MISS. Nothing here checks whether another concurrent caller is
    // already fetching the same key - that is exactly the bug.
    const product = await getProductFromDatabase(productId);
    await redis.set(key, JSON.stringify(product), "EX", ttlSeconds);
    return product;
  }

  return { getProduct };
}
