import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPool, waitForDatabase } from "@labs/db-utils";
import * as schema from "./schema.js";

if (!process.env.PRIMARY_DATABASE_URL) {
  throw new Error("PRIMARY_DATABASE_URL is not set - copy .env.example to .env first");
}

// All schema DDL and all NORMAL application writes go through this pool.
// During this lab's failover scenario, the container behind this pool is
// deliberately stopped - see src/scenarios/failover-and-promote.ts, which
// opens its own short-lived pg.Client connections rather than reusing this
// long-lived pool, since a Pool that has cached dead sockets from before the
// container stopped is not a reliable way to observe "is it down yet."
export const primaryPool = createPool({ connectionString: process.env.PRIMARY_DATABASE_URL });

export const primaryDb = drizzle(primaryPool, { schema });

export { waitForDatabase };
