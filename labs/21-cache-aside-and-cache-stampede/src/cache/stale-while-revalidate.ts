import type { Redis } from "ioredis";
import { createLogger } from "@labs/logging";
import type { Product } from "../db/product-repository.js";
import { productCacheKey } from "./cache-key.js";

const log = createLogger("lab21:cache:stale-while-revalidate");

export interface StaleWhileRevalidateOptions {
  /** How long a cached value is trusted as "fresh" - served with no background work at all. */
  freshMs?: number;
  /**
   * Total time a value remains servable at all (fresh + stale-acceptable).
   * Also used directly as the Redis key's own TTL, so a value past this
   * point simply isn't in Redis any more and this behaves like a cold miss.
   */
  staleMs?: number;
}

interface CacheEntry {
  product: Product;
  freshUntil: number;
}

/**
 * FIX #3: STALE-WHILE-REVALIDATE.
 *
 * Every cached entry carries its own "freshUntil" timestamp alongside the
 * value. A request:
 *
 * - within the fresh window: returns the cached value immediately, no
 *   background work at all;
 * - past the fresh window but the key still exists (within the longer
 *   "stale-acceptable" window, enforced by the Redis key's own TTL):
 *   returns the STALE cached value immediately (fast - no waiting on the
 *   slow database call) AND kicks off a background refresh, deduplicated
 *   per key via `refreshInFlight` so a burst of stale requests only
 *   triggers one background refresh, not one per caller;
 * - key entirely missing (cold, or past even the stale window): falls back
 *   to a normal cache-aside miss - blocks on the database like
 *   naive-cache-aside.ts, then populates the entry.
 *
 * The tradeoff this makes explicit: a caller can receive a value that is up
 * to (staleMs - freshMs) milliseconds out of date, in exchange for never
 * paying the slow-database-call latency on an expired-but-still-known key.
 * Contrast with naive-cache-aside.ts, where EVERY expiry produces a full
 * latency spike for whichever caller happens to hit the miss.
 */
export function createStaleWhileRevalidateCache(
  redis: Redis,
  getProductFromDatabase: (productId: number) => Promise<Product>,
  options: StaleWhileRevalidateOptions = {},
) {
  const freshMs = options.freshMs ?? 500;
  const staleMs = options.staleMs ?? 5_000;
  const refreshInFlight = new Set<string>();

  async function writeEntry(key: string, product: Product): Promise<void> {
    const entry: CacheEntry = { product, freshUntil: Date.now() + freshMs };
    await redis.set(key, JSON.stringify(entry), "PX", staleMs);
  }

  function triggerBackgroundRefresh(key: string, productId: number): void {
    if (refreshInFlight.has(key)) {
      return;
    }
    refreshInFlight.add(key);
    getProductFromDatabase(productId)
      .then((product) => writeEntry(key, product))
      .catch((error: unknown) => {
        log.error({ err: error, productId }, "background revalidation failed");
      })
      .finally(() => {
        refreshInFlight.delete(key);
      });
  }

  async function getProduct(productId: number): Promise<Product> {
    const key = productCacheKey(productId);
    const raw = await redis.get(key);

    if (raw) {
      const entry = JSON.parse(raw) as CacheEntry;
      if (entry.freshUntil > Date.now()) {
        return entry.product;
      }
      // Stale but present: serve it immediately, refresh in the background.
      triggerBackgroundRefresh(key, productId);
      return entry.product;
    }

    // Cold miss (or past the stale-acceptable window entirely) - no stale
    // value to fall back on, so this call pays the full database latency,
    // exactly like naive-cache-aside.ts.
    const product = await getProductFromDatabase(productId);
    await writeEntry(key, product);
    return product;
  }

  /** Exposed for tests: lets a test await the in-flight background refresh instead of guessing a sleep duration. */
  function isRefreshing(productId: number): boolean {
    return refreshInFlight.has(productCacheKey(productId));
  }

  return { getProduct, isRefreshing };
}
