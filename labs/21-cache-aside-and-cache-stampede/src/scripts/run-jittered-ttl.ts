import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import {
  seedFixedTtlKeys,
  seedJitteredTtlKeys,
  measureExpirationWindow,
  fixedTtlKey,
  jitteredTtlKey,
} from "../cache/jittered-ttl.js";
import { createRedisClient, waitForRedis } from "../cache/redis-client.js";

const log = createLogger("lab21:scenario:jittered-ttl");

const KEY_COUNT = 200;
const BASE_TTL_MS = 2_000;
const JITTER_FRACTION = 0.2;
const POLL_INTERVAL_MS = 25;
const MAX_WAIT_MS = BASE_TTL_MS * 2;

async function main(): Promise<void> {
  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is not set - copy .env.example to .env first");
  }
  const redis = createRedisClient(process.env.REDIS_URL);
  await waitForRedis(redis);

  log.info(
    { keyCount: KEY_COUNT, baseTtlMs: BASE_TTL_MS, jitterFraction: JITTER_FRACTION },
    "seeding fixed-TTL and jittered-TTL key sets at (as close as possible to) the same instant",
  );

  await Promise.all([
    seedFixedTtlKeys(redis, KEY_COUNT, BASE_TTL_MS),
    seedJitteredTtlKeys(redis, KEY_COUNT, { baseTtlMs: BASE_TTL_MS, jitterFraction: JITTER_FRACTION }),
  ]);

  const [fixedWindow, jitteredWindow] = await Promise.all([
    measureExpirationWindow(redis, fixedTtlKey, KEY_COUNT, POLL_INTERVAL_MS, MAX_WAIT_MS),
    measureExpirationWindow(redis, jitteredTtlKey, KEY_COUNT, POLL_INTERVAL_MS, MAX_WAIT_MS),
  ]);

  const fixedSpreadMs =
    fixedWindow.firstExpiryMs !== null && fixedWindow.lastExpiryMs !== null
      ? fixedWindow.lastExpiryMs - fixedWindow.firstExpiryMs
      : null;
  const jitteredSpreadMs =
    jitteredWindow.firstExpiryMs !== null && jitteredWindow.lastExpiryMs !== null
      ? jitteredWindow.lastExpiryMs - jitteredWindow.firstExpiryMs
      : null;

  log.info(
    { fixedWindow, jitteredWindow, fixedSpreadMs, jitteredSpreadMs, pollIntervalMs: POLL_INTERVAL_MS },
    fixedSpreadMs !== null && jitteredSpreadMs !== null && jitteredSpreadMs > fixedSpreadMs
      ? "FIXED (preventive): jittered-TTL keys expired across a measurably wider window than fixed-TTL keys"
      : "unexpected: jittered spread was not measurably wider than fixed spread this run",
  );

  await redis.quit();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "jittered-ttl scenario failed");
    process.exit(1);
  });
}
