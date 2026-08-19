import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPool, waitForDatabase } from "@labs/db-utils";
import * as schema from "./schema.js";

if (!process.env.REPLICA1_DATABASE_URL) {
  throw new Error("REPLICA1_DATABASE_URL is not set - copy .env.example to .env first");
}

// replica-1 streams directly from the primary (the first hop of the
// cascade). It is also itself the UPSTREAM source for replica-2 - see
// replica2-client.ts and docker-compose.yml.
export const replica1Pool = createPool({ connectionString: process.env.REPLICA1_DATABASE_URL });

export const replica1Db = drizzle(replica1Pool, { schema });

export { waitForDatabase };
