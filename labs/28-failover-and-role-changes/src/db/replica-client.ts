import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPool, waitForDatabase } from "@labs/db-utils";
import * as schema from "./schema.js";

if (!process.env.REPLICA_DATABASE_URL) {
  throw new Error("REPLICA_DATABASE_URL is not set - copy .env.example to .env first");
}

// A genuinely separate connection to a genuinely separate Postgres node.
// Before failover, this node is a physical standby and Postgres itself
// rejects writes here (SQLSTATE 25006), exactly as in Lab 24. After this
// lab's failover scenario calls pg_promote() against this SAME connection
// string, it becomes a real, independent, writable primary - the node's
// role changed, the connection string and the underlying container did not.
export const replicaPool = createPool({ connectionString: process.env.REPLICA_DATABASE_URL });

export const replicaDb = drizzle(replicaPool, { schema });

export { waitForDatabase };
