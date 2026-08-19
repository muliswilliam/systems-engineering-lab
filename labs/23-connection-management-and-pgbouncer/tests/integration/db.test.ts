import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { widgets } from "../../src/db/schema.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

describe("schema foundations", () => {
  it("inserts a widget and generates a public UUID", async () => {
    const [inserted] = await db.insert(widgets).values({ name: "Test Widget", value: 42 }).returning();

    expect(inserted).toBeDefined();
    expect(inserted!.publicId).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserted!.id).toBeGreaterThan(0);
  });

  it("reports the lowered max_connections this lab configures", async () => {
    const { rows } = await pool.query<{ max_connections: string }>(
      "SHOW max_connections",
    );
    // See .env.example / README "Break it": deliberately lowered from
    // Postgres's built-in default of 100 so the exhaustion scenario is fast
    // and reliable, not just "eventually, given enough OS processes".
    expect(Number(rows[0]!.max_connections)).toBeLessThanOrEqual(50);
  });
});
