import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPool, waitForDatabase } from "@labs/db-utils";
import * as schema from "./schema.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
}

// max: 20 is plenty for Drizzle-side reads/writes (seed, dev, migrate). The
// scenario scripts and concurrency tests that need 100+ simultaneous
// connections create their own dedicated `pg` Pool with a much higher `max`
// (see src/scenarios/*.ts) instead of sharing this one - see README
// "Architecture" for why a single shared pool would defeat the race being
// reproduced.
export const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 20 });

export const db = drizzle(pool, { schema });

export { waitForDatabase };
