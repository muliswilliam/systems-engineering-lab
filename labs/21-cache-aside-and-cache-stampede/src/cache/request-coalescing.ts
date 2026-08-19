import type { Redis } from "ioredis";
import type { Product } from "../db/product-repository.js";
import { productCacheKey } from "./cache-key.js";

export interface CoalescingCacheOptions {
  ttlSeconds?: number;
}

/**
 * FIX #1: IN-PROCESS REQUEST COALESCING.
 *
 * Keeps an in-memory map of "a fetch for this key is already in flight."
 * Concurrent callers *within the same Node process* awaiting the same
 * product id share the single underlying database call instead of each
 * starting their own - the naive version's stampede becomes exactly 1
 * database call no matter how many concurrent callers ask.
 *
 * Why this works even without an explicit "check in-flight first, then
 * check Redis" ordering: Node runs the synchronous portion of every
 * `getProduct` call to completion before yielding at the first `await`. When
 * N concurrent callers are all invoked back-to-back in a tight loop (as
 * `runConcurrently` does), caller 1 registers its in-flight promise in
 * `inFlight` synchronously *before* it awaits anything, so by the time
 * caller 2 runs its own synchronous prologue, `inFlight.get(key)` already
 * finds caller 1's promise. This is a genuine, observable consequence of
 * JavaScript's single-threaded run-to-completion semantics, not a race that
 * happens to usually work.
 *
 * What this does NOT fix: a second Node process (a second replica of the
 * same API) has its own, separate `inFlight` map, so it will still issue its
 * own database call on a cold key. See lease-based-refill.ts for the
 * mitigation that works across processes.
 */
export function createCoalescingCache(
  redis: Redis,
  getProductFromDatabase: (productId: number) => Promise<Product>,
  options: CoalescingCacheOptions = {},
) {
  const ttlSeconds = options.ttlSeconds ?? 30;
  const inFlight = new Map<string, Promise<Product>>();

  async function getProduct(productId: number): Promise<Product> {
    const key = productCacheKey(productId);

    const existing = inFlight.get(key);
    if (existing) {
      return existing;
    }

    const promise = (async (): Promise<Product> => {
      const cached = await redis.get(key);
      if (cached) {
        return JSON.parse(cached) as Product;
      }

      const product = await getProductFromDatabase(productId);
      await redis.set(key, JSON.stringify(product), "EX", ttlSeconds);
      return product;
    })();

    inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(key);
    }
  }

  return { getProduct };
}
