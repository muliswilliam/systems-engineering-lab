import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPool, waitForDatabase } from "@labs/db-utils";
import * as schema from "./schema.js";

if (!process.env.REPLICA_DATABASE_URL) {
  throw new Error("REPLICA_DATABASE_URL is not set - copy .env.example to .env first");
}

// A genuinely separate connection to a genuinely separate Postgres node.
// Every "read your own profile back" attempt in this lab's scenarios reads
// from this pool - the entire lesson is about what happens when that read
// lands here instead of on the primary.
export const replicaPool = createPool({ connectionString: process.env.REPLICA_DATABASE_URL });

export const replicaDb = drizzle(replicaPool, { schema });

export { waitForDatabase };
