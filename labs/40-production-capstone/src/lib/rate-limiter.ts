import type { Redis } from "ioredis";

/**
 * Token bucket rate limiting at the checkout API boundary, reused fresh from
 * Lab 36's own `src/rate-limit/token-bucket.ts` (independent copy, per the
 * independent-labs principle). A single atomic Lua script avoids the
 * check-then-act race a naive GET/compare/SET sequence would have under
 * concurrency - see Lab 36's README for the full explanation. This capstone
 * uses it for exactly the role SPEC.md's own component list assigns it:
 * protecting the API from an oversized burst BEFORE it ever reaches
 * Postgres, a separate concern from idempotency (which protects against
 * DUPLICATE logical requests that already got past the rate limiter).
 */
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_second = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl_seconds = tonumber(ARGV[5])

local data = redis.call('HMGET', key, 'tokens', 'last_refill_ms')
local tokens = tonumber(data[1])
local last_refill_ms = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  last_refill_ms = now_ms
end

local elapsed_seconds = math.max(0, (now_ms - last_refill_ms) / 1000)
tokens = math.min(capacity, tokens + elapsed_seconds * refill_per_second)

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call('HMSET', key, 'tokens', tostring(tokens), 'last_refill_ms', tostring(now_ms))
redis.call('EXPIRE', key, ttl_seconds)

return { allowed, tostring(tokens) }
`;

export interface TokenBucketConfig {
  capacity: number;
  refillPerSecond: number;
  cost?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  tokensRemaining: number;
}

export function createTokenBucketLimiter(redis: Redis, config: TokenBucketConfig) {
  const cost = config.cost ?? 1;

  return {
    async check(clientKey: string, now: number = Date.now()): Promise<RateLimitDecision> {
      const key = `lab40:ratelimit:${clientKey}`;
      const ttlSeconds = Math.max(60, Math.ceil((config.capacity / config.refillPerSecond) * 4));
      const result = (await redis.eval(
        TOKEN_BUCKET_SCRIPT,
        1,
        key,
        config.capacity,
        config.refillPerSecond,
        now,
        cost,
        ttlSeconds,
      )) as [number, string];
      const [allowed, tokensRemaining] = result;
      return { allowed: allowed === 1, tokensRemaining: Number(tokensRemaining) };
    },
  };
}
