import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPool, waitForDatabase } from "@labs/db-utils";
import * as schema from "./schema.js";

// The DEFAULT client (used by db:migrate and drizzle-kit) connects as the
// MIGRATOR role - see .env.example / README "Setup" for why. Scenarios and
// tests that need a specific role's actual privilege boundary use
// src/db/roles.ts instead, which builds a fresh Pool per role rather than
// sharing this one.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
}

export const pool = createPool({ connectionString: process.env.DATABASE_URL });

export const db = drizzle(pool, { schema });

export { waitForDatabase };
