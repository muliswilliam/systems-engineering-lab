import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPool, waitForDatabase } from "@labs/db-utils";
import * as schema from "./schema.js";

if (!process.env.REPLICA_DATABASE_URL) {
  throw new Error("REPLICA_DATABASE_URL is not set - copy .env.example to .env first");
}

// A genuinely separate connection to a genuinely separate Postgres node. A
// physical standby rejects writes at the Postgres level (SQLSTATE 25006,
// "cannot execute INSERT in a read-only transaction") - Drizzle/pg do not
// need to enforce read-only-ness in application code, Postgres already does.
export const replicaPool = createPool({ connectionString: process.env.REPLICA_DATABASE_URL });

export const replicaDb = drizzle(replicaPool, { schema });

export { waitForDatabase };
