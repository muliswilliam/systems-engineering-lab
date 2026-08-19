import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPool, waitForDatabase } from "@labs/db-utils";
import * as schema from "./schema.js";

if (!process.env.PRIMARY_DATABASE_URL) {
  throw new Error("PRIMARY_DATABASE_URL is not set - copy .env.example to .env first");
}

// The ONLY pool/db this lab's router is allowed to use for writes,
// read-after-write reads, and transactions. See src/router/router.ts.
export const primaryPool = createPool({ connectionString: process.env.PRIMARY_DATABASE_URL });

export const primaryDb = drizzle(primaryPool, { schema });

export { waitForDatabase };
