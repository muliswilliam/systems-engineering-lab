import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPool, waitForDatabase } from "@labs/db-utils";
import * as schema from "./schema.js";

if (!process.env.PRIMARY_DATABASE_URL) {
  throw new Error("PRIMARY_DATABASE_URL is not set - copy .env.example to .env first");
}

// All schema DDL and all application writes go through this pool. Neither
// replica is ever written to directly - see replica1-client.ts and
// replica2-client.ts.
export const primaryPool = createPool({ connectionString: process.env.PRIMARY_DATABASE_URL });

export const primaryDb = drizzle(primaryPool, { schema });

export { waitForDatabase };
