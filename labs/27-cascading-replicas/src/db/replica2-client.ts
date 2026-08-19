import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPool, waitForDatabase } from "@labs/db-utils";
import * as schema from "./schema.js";

if (!process.env.REPLICA2_DATABASE_URL) {
  throw new Error("REPLICA2_DATABASE_URL is not set - copy .env.example to .env first");
}

// replica-2 streams from REPLICA-1, NOT from the primary - this connection
// string points at a Postgres node that never opens a connection to the
// primary at all. Everything replica-2 knows, it learned secondhand via
// replica-1's own re-forwarded WAL stream. See docker-compose.yml and
// README.md "Architecture" for the full topology.
export const replica2Pool = createPool({ connectionString: process.env.REPLICA2_DATABASE_URL });

export const replica2Db = drizzle(replica2Pool, { schema });

export { waitForDatabase };
