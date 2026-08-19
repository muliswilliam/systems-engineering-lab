import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Schema DDL and migrations only ever run against the PRIMARY, same as
// Lab 24 - the replica receives its schema via physical WAL replay, not a
// second drizzle-kit run.
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
