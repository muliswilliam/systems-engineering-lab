import type { Redis } from "ioredis";

/**
 * Token bucket rate limiting, backed by a real Redis hash and a single
 * atomic Lua script (per CLAUDE.md's "prefer datastore-native guarantees" -
 * the counter and its check-and-decrement live in the datastore, not in
 * application memory, so this works correctly across any number of
 * application processes, not just one).
 *
 * Why a Lua script instead of separate HGET/HSET calls: a naive
 * "read tokens, check, write tokens back" sequence issued as separate Redis
 * commands has a check-then-act race under concurrency - two concurrent
 * callers could both read "1 token left", both decide to allow, and both
 * decrement, letting the bucket go negative. A Lua script runs to completion
 * on Redis's single command-execution thread with no other command
 * interleaved, so the read-check-write here is genuinely atomic - the same
 * reason Lab 11's `UPDATE ... WHERE version = ?` conditional write is
 * atomic at the Postgres row level.
 *
 * Semantics: capacity tokens, refilling continuously at `refillPerSecond`
 * tokens/second, lazily computed on each call from the elapsed time since
 * the bucket's last touch (no background timer needed). A request costing
 * `cost` tokens (default 1) is allowed only if the bucket currently holds at
 * least that many tokens.
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
  /** Maximum tokens the bucket can ever hold (also the maximum burst size). */
  capacity: number;
  /** Steady-state tokens refilled per second. */
  refillPerSecond: number;
  /** How many tokens one request costs. */
  cost?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Tokens remaining (token bucket) or requests already counted in the current window (sliding window). */
  detail: number;
}

export function createTokenBucketLimiter(redis: Redis, config: TokenBucketConfig) {
  const cost = config.cost ?? 1;

  return {
    async check(clientKey: string, now: number = Date.now()): Promise<RateLimitDecision> {
      const key = `ratelimit:tokenbucket:${clientKey}`;
      // TTL generously covers how long an idle bucket's state is worth
      // keeping around - a bucket that hasn't been touched in that long is
      // indistinguishable from a fresh, full one anyway.
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
      return { allowed: allowed === 1, detail: Number(tokensRemaining) };
    },
  };
}
