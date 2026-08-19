import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool, waitForDatabase } from "../../src/db/client.js";
import { setupNaiveTables, runNaiveBadInserts } from "../../src/scenarios/naive-inserts.js";

/**
 * These tests exercise the deliberately under-constrained `naive_companies`
 * / `naive_employees` tables (see src/scenarios/naive-inserts.ts) and assert
 * the failure mode this lab exists to teach: without a foreign key, a
 * unique constraint, and CHECK constraints, Postgres happily accepts data
 * that the corrected schema in constraints.test.ts rejects outright.
 */
beforeAll(async () => {
  await waitForDatabase(pool);
  await setupNaiveTables(pool);
});

afterAll(async () => {
  await pool.query("DROP TABLE IF EXISTS naive_employees");
  await pool.query("DROP TABLE IF EXISTS naive_companies");
  await pool.end();
});

describe("naive schema (no FK, no unique public_id, no CHECK)", () => {
  it("accepts every bad insert the corrected schema would reject", async () => {
    const results = await runNaiveBadInserts(pool);

    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result.succeeded, `expected "${result.label}" to succeed against the naive schema`).toBe(
        true,
      );
    }
  });

  it("really did insert an employee pointing at a nonexistent company", async () => {
    // node-postgres returns `bigint` columns as strings to avoid precision
    // loss, so compare as a number explicitly rather than relying on `toBe`.
    const { rows } = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM naive_employees WHERE full_name = 'Ghost Employee'`,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.company_id)).toBe(999_999_999);

    const { rows: companyRows } = await pool.query(
      `SELECT id FROM naive_companies WHERE id = $1`,
      [999_999_999],
    );
    expect(companyRows).toHaveLength(0);
  });

  it("really did store a negative salary", async () => {
    const { rows } = await pool.query<{ annual_salary_cents: number }>(
      `SELECT annual_salary_cents FROM naive_employees WHERE full_name = 'Underpaid Employee'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.annual_salary_cents).toBeLessThan(0);
  });
});
