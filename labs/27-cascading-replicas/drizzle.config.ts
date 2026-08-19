import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Schema DDL and migrations only ever run against the PRIMARY. Neither
// replica runs its own drizzle-kit generation or migration - both receive
// their schema purely via physical WAL replay, replica-2 via replica-1's
// re-forwarded WAL stream. See src/db/migrate.ts and README.md "Scenario".
if (!process.env.PRIMARY_DATABASE_URL) {
  throw new Error("PRIMARY_DATABASE_URL is not set - copy .env.example to .env first");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.PRIMARY_DATABASE_URL,
  },
});
