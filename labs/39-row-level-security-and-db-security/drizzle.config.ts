import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// drizzle-kit connects and applies `db:generate`'s diffing/introspection as
// whatever DATABASE_URL points at. This lab points it at the MIGRATOR role
// (see .env.example) - drizzle-kit never runs as the admin/superuser role,
// and never runs as the app/readonly roles (which lack CREATE).
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
