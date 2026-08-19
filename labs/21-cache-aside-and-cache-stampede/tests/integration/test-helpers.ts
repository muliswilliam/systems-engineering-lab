import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { products } from "../../src/db/schema.js";
import { createRedisClient, waitForRedis } from "../../src/cache/redis-client.js";

export async function setupDatabase(): Promise<void> {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
}

/** Inserts one deterministic product row and returns its internal id. */
export async function insertTestProduct(name: string, priceCents: number): Promise<number> {
  const [row] = await db.insert(products).values({ name, priceCents }).returning({ id: products.id });
  if (!row) {
    throw new Error("Failed to insert test product");
  }
  return row.id;
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
