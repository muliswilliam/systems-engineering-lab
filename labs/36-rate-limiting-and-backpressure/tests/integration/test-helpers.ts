import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { createRedisClient, waitForRedis } from "../../src/redis/redis-client.js";

export async function setupDatabase(): Promise<void> {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
}

export function getRedisUrl(): string {
  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL is not set - copy .env.example to .env first");
  }
  return process.env.REDIS_URL;
}

export async function createTestRedisClient() {
  const redis = createRedisClient(getRedisUrl());
  await waitForRedis(redis);
  return redis;
}
