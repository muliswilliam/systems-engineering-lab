import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

/**
 * Sliding window log rate limiting, backed by a real Redis sorted set (score
 * = request timestamp in ms) and a single atomic Lua script. Unlike a fixed
 * window counter (reset every N ms on a wall-clock boundary, which lets up
 * to 2x the limit through across a boundary - e.g. 100 requests in the last
 * 1ms of one window plus 100 more in the first 1ms of the next), a sliding
 * window log always looks at a continuously-moving `[now - windowMs, now]`
 * range, so the limit is exact no matter when requests happen to land
 * relative to any fixed boundary. The cost is O(log N) per request (a
 * sorted-set trim + cardinality check) instead of a fixed window's O(1)
 * INCR - a real, worth-naming tradeoff, not free precision.
 *
 * Atomicity note: same reasoning as token-bucket.ts - trimming expired
 * entries, counting, and conditionally adding a new entry must happen as one
 * indivisible operation, or two concurrent callers could both see
 * `count < limit` and both get admitted, letting the window exceed its cap.
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now_ms - window_ms)
local count = redis.call('ZCARD', key)

local allowed = 0
if count < limit then
  redis.call('ZADD', key, now_ms, member)
  allowed = 1
  count = count + 1
end

redis.call('PEXPIRE', key, window_ms)

return { allowed, count }
`;

export interface SlidingWindowConfig {
  windowMs: number;
  limit: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  detail: number;
}

export function createSlidingWindowLimiter(redis: Redis, config: SlidingWindowConfig) {
  return {
    async check(clientKey: string, now: number = Date.now()): Promise<RateLimitDecision> {
      const key = `ratelimit:slidingwindow:${clientKey}`;
      // A unique member per request - two requests landing at the exact same
      // millisecond must both occupy a distinct sorted-set slot, or the
      // second would silently overwrite the first's entry (ZADD dedupes on
      // member) and the window would undercount.
      const member = `${now}:${randomUUID()}`;
      const result = (await redis.eval(
        SLIDING_WINDOW_SCRIPT,
        1,
        key,
        now,
        config.windowMs,
        config.limit,
        member,
      )) as [number, number];
      const [allowed, count] = result;
      return { allowed: allowed === 1, detail: count };
    },
  };
}
