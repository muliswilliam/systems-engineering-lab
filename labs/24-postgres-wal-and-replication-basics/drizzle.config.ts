import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Schema DDL and migrations only ever run against the PRIMARY. The replica
// receives its schema via physical WAL replay of the primary, not via a
// second drizzle-kit run - see src/db/migrate.ts and README.md "Scenario".
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
