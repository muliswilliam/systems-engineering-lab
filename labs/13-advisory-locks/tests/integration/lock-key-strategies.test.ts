import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool, waitForDatabase, db } from "../../src/db/client.js";
import { ensureScenarioCompanies } from "../../src/seed/ensure-scenario-companies.js";
import { approxCollisionProbability, runLockKeyStrategies } from "../../src/scenarios/uuid-vs-numeric-lock-key.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await ensureScenarioCompanies();
});

afterAll(async () => {
  await pool.end();
});

describe("numeric internal id vs hashed public UUID as an advisory-lock key", () => {
  it("both a direct numeric-id key and a hashed-UUID key successfully acquire and release", async () => {
    const result = await runLockKeyStrategies(process.env.DATABASE_URL!);

    expect(result.numericKeyAcquired).toBe(true);
    expect(result.hashedUuidBigintKeyAcquired).toBe(true);
    expect(result.splitUuidTwoIntKeyAcquired).toBe(true);
    expect(result.splitUuidTwoIntKeyValues).toHaveLength(2);
  });
});

describe("approxCollisionProbability (pure math, no DB)", () => {
  it("grows with n and shrinks as the key space widens from 32 to 64 bits", () => {
    const at32 = approxCollisionProbability(100_000, 32);
    const at64 = approxCollisionProbability(100_000, 64);

    expect(at32).toBeGreaterThan(at64);
    expect(at32).toBeGreaterThan(0);
    expect(at32).toBeLessThanOrEqual(1);
  });

  it("is effectively zero for a small number of companies in a 64-bit space", () => {
    expect(approxCollisionProbability(1_000, 64)).toBeLessThan(1e-9);
  });
});
