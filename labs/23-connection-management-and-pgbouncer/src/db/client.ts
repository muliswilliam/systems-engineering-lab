import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPool, waitForDatabase } from "@labs/db-utils";
import * as schema from "./schema.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
}

// Direct-to-Postgres pool, used by migrate.ts, seed.ts, and anywhere the lab
// needs an ordinary application connection. Scenario scripts that need to
// compare direct connections against PgBouncer-pooled connections build
// their own short-lived pg.Pool/Client instances against the connection
// strings in src/db/connections.ts instead of reusing this shared pool -
// see that file for why.
export const pool = createPool({ connectionString: process.env.DATABASE_URL });

export const db = drizzle(pool, { schema });

export { waitForDatabase };
