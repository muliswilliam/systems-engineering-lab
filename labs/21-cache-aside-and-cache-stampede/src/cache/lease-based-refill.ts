import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Product } from "../db/product-repository.js";
import { productCacheKey, sleep } from "./cache-key.js";

export interface LeaseCacheOptions {
  ttlSeconds?: number;
  /** How long a refill lease is held before it expires on its own. */
  leaseMs?: number;
  /** How often a waiter re-checks the cache while someone else holds the lease. */
  pollIntervalMs?: number;
  /** How many times a waiter will re-attempt the whole flow (acquire-or-wait) before giving up. */
  maxAttempts?: number;
}

/**
 * Atomically releases the lease ONLY if the caller still owns it (its
 * `owner` token still matches what's stored). A plain `DEL` would risk
 * deleting a lease some OTHER caller acquired after this caller's lease
 * already expired on its own - the classic "safe release" concern this lab
 * foreshadows for Lab 22's fuller distributed-lock treatment (ownership
 * tokens, fencing). `EVAL` makes the compare-then-delete atomic.
 */
const RELEASE_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/**
 * FIX #2: A SHORT REDIS LEASE ("SOMEONE IS ALREADY REFILLING THIS KEY").
 *
 * Unlike request coalescing (in-process only), this works ACROSS processes,
 * because the coordination lives in Redis rather than in one Node process's
 * memory. On a cache miss, every caller tries `SET lock:<key> <owner> NX PX
 * <leaseMs>`:
 *
 * - The one caller whose `SET ... NX` succeeds holds the lease. It alone
 *   calls the slow database function, populates the cache, then releases
 *   the lease (only if it still owns it).
 * - Every other caller's `SET ... NX` fails (the key already exists) - they
 *   poll the cache briefly instead of calling the database themselves. Once
 *   the lease-holder populates the cache, the very next poll finds it.
 *
 * This lab demonstrates "multiple processes" the same way Labs 05-19
 * demonstrate "multiple sessions" - with multiple independent `ioredis`
 * connections (`createLeaseBasedCache` is called once per simulated
 * process, each with its OWN `Redis` client instance and its own module-
 * level state), not multiple real OS processes. The lease itself lives in
 * Redis, not in any one connection's memory, which is exactly the property
 * that makes it work across those independent instances.
 */
export function createLeaseBasedCache(
  redis: Redis,
  getProductFromDatabase: (productId: number) => Promise<Product>,
  options: LeaseCacheOptions = {},
) {
  const ttlSeconds = options.ttlSeconds ?? 30;
  const leaseMs = options.leaseMs ?? 2_000;
  const pollIntervalMs = options.pollIntervalMs ?? 20;
  const maxAttempts = options.maxAttempts ?? 5;

  async function pollForCacheValue(key: string, maxWaitMs: number): Promise<Product | null> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const cached = await redis.get(key);
      if (cached) {
        return JSON.parse(cached) as Product;
      }
      await sleep(pollIntervalMs);
    }
    return null;
  }

  async function getProduct(productId: number, attempt = 1): Promise<Product> {
    const key = productCacheKey(productId);
    const lockKey = `lock:${key}`;

    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached) as Product;
    }

    const owner = randomUUID();
    const acquired = await redis.set(lockKey, owner, "PX", leaseMs, "NX");

    if (acquired === "OK") {
      try {
        const product = await getProductFromDatabase(productId);
        await redis.set(key, JSON.stringify(product), "EX", ttlSeconds);
        return product;
      } finally {
        await redis.eval(RELEASE_IF_OWNER_SCRIPT, 1, lockKey, owner);
      }
    }

    // Someone else holds the lease - wait a little past the lease's own
    // lifetime for them to populate the cache, then re-check the cache one
    // more time before giving up on this attempt.
    const value = await pollForCacheValue(key, leaseMs + 250);
    if (value) {
      return value;
    }

    if (attempt >= maxAttempts) {
      throw new Error(
        `Lease-based refill gave up after ${maxAttempts} attempts for product ${productId} - the lease holder never populated the cache`,
      );
    }

    // The lease-holder likely crashed or was abnormally slow and its lease
    // has since expired. Retry the whole flow: this caller (or a different
    // one) will race to acquire a fresh lease.
    return getProduct(productId, attempt + 1);
  }

  return { getProduct };
}
