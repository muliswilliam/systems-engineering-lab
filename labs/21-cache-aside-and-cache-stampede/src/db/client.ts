import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPool, waitForDatabase } from "@labs/db-utils";
import * as schema from "./schema.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
}

export const pool = createPool({ connectionString: process.env.DATABASE_URL });

export const db = drizzle(pool, { schema });

export { waitForDatabase };
