import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPool, waitForDatabase } from "@labs/db-utils";
import * as schema from "./schema.js";

if (!process.env.REPLICA_DATABASE_URL) {
  throw new Error("REPLICA_DATABASE_URL is not set - copy .env.example to .env first");
}

// A genuinely separate connection to a genuinely separate Postgres node -
// used ONLY for ordinary reads by the corrected router. Never used for
// writes, read-after-write reads, or transactions - see
// src/router/router.ts and src/router/classify.ts.
export const replicaPool = createPool({ connectionString: process.env.REPLICA_DATABASE_URL });

export const replicaDb = drizzle(replicaPool, { schema });

export { waitForDatabase };
