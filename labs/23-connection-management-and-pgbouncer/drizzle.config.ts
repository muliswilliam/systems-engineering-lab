import "dotenv/config";
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Migrations run directly against Postgres, never through a
    // transaction-pooling PgBouncer - see src/db/migrate.ts for why.
    url: process.env.DATABASE_URL,
  },
});
