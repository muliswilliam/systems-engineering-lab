import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { companies, employees } from "../../src/db/schema.js";

/** Postgres error class codes this lab asserts on - see errcodes-appendix. */
const PG_NOT_NULL_VIOLATION = "23502";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const PG_UNIQUE_VIOLATION = "23505";
const PG_CHECK_VIOLATION = "23514";

/**
 * Both Drizzle (node-postgres driver) and the raw `pg` pool surface the
 * underlying Postgres error unwrapped, so `.code` is present directly on
 * whatever `db.insert(...)` or `pool.query(...)` rejects with.
 */
function pgErrorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

async function insertTestCompany(name: string) {
  const [company] = await db
    .insert(companies)
    .values({ name, country: "United States", currency: "USD" })
    .returning();
  return company!;
}

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

describe("foreign key: employees.company_id -> companies.id", () => {
  it("rejects an employee referencing a company that does not exist, with 23503", async () => {
    const error = await db
      .insert(employees)
      .values({
        companyId: 999_999_999,
        fullName: "Ghost Employee",
        email: `ghost-${Date.now()}@example.com`,
        role: "engineer",
        annualSalaryCents: 10_000_000,
        currency: "USD",
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(pgErrorCode(error)).toBe(PG_FOREIGN_KEY_VIOLATION);
  });
});

describe("unique constraint: companies.public_id", () => {
  it("rejects a second company reusing an existing public_id, with 23505", async () => {
    const first = await insertTestCompany("Unique Public ID Co A");

    const error = await db
      .insert(companies)
      .values({
        publicId: first.publicId,
        name: "Unique Public ID Co B",
        country: "United States",
        currency: "USD",
      })
      .catch((e: unknown) => e);

    expect(pgErrorCode(error)).toBe(PG_UNIQUE_VIOLATION);

    await db.delete(companies).where(eq(companies.id, first.id));
  });
});

describe("unique constraint: employees.email", () => {
  it("rejects a second employee reusing an existing email, with 23505", async () => {
    const company = await insertTestCompany("Unique Email Co");
    const email = `dup-${Date.now()}@example.com`;

    await db.insert(employees).values({
      companyId: company.id,
      fullName: "First Claimant",
      email,
      role: "engineer",
      annualSalaryCents: 10_000_000,
      currency: "USD",
    });

    const error = await db
      .insert(employees)
      .values({
        companyId: company.id,
        fullName: "Second Claimant",
        email,
        role: "engineer",
        annualSalaryCents: 10_000_000,
        currency: "USD",
      })
      .catch((e: unknown) => e);

    expect(pgErrorCode(error)).toBe(PG_UNIQUE_VIOLATION);

    await db.delete(employees).where(eq(employees.companyId, company.id));
    await db.delete(companies).where(eq(companies.id, company.id));
  });
});

describe("check constraint: employees.annual_salary_cents > 0", () => {
  it("rejects a negative salary, with 23514", async () => {
    const company = await insertTestCompany("Negative Salary Co");

    const error = await db
      .insert(employees)
      .values({
        companyId: company.id,
        fullName: "Underpaid Employee",
        email: `underpaid-${Date.now()}@example.com`,
        role: "engineer",
        annualSalaryCents: -500_000,
        currency: "USD",
      })
      .catch((e: unknown) => e);

    expect(pgErrorCode(error)).toBe(PG_CHECK_VIOLATION);

    await db.delete(companies).where(eq(companies.id, company.id));
  });

  it("rejects a zero salary too - the check is strictly greater than zero, with 23514", async () => {
    const company = await insertTestCompany("Zero Salary Co");

    const error = await db
      .insert(employees)
      .values({
        companyId: company.id,
        fullName: "Volunteer Employee",
        email: `volunteer-${Date.now()}@example.com`,
        role: "engineer",
        annualSalaryCents: 0,
        currency: "USD",
      })
      .catch((e: unknown) => e);

    expect(pgErrorCode(error)).toBe(PG_CHECK_VIOLATION);

    await db.delete(companies).where(eq(companies.id, company.id));
  });
});

describe("check constraint: employees.employment_status IN ('active', 'terminated')", () => {
  it("rejects an employment_status outside the allowed set, with 23514", async () => {
    const company = await insertTestCompany("Invalid Status Co");

    // Bypass Drizzle's string type on purpose via the raw pool - this is the
    // same thing a hand-written migration script, a `psql` session, or a bug
    // in an unrelated service could do.
    const error = await pool
      .query(
        `INSERT INTO employees (company_id, full_name, email, role, annual_salary_cents, currency, employment_status)
         VALUES ($1, 'Schrodinger Employee', $2, 'engineer', 10000000, 'USD', 'quantum_superposition')`,
        [company.id, `schrodinger-${Date.now()}@example.com`],
      )
      .catch((e: unknown) => e);

    expect(pgErrorCode(error)).toBe(PG_CHECK_VIOLATION);

    await db.delete(companies).where(eq(companies.id, company.id));
  });
});

describe("not-null constraint: employees.full_name", () => {
  it("rejects a missing full_name, with 23502", async () => {
    const company = await insertTestCompany("Nameless Co");

    const error = await pool
      .query(
        `INSERT INTO employees (company_id, full_name, email, role, annual_salary_cents, currency, employment_status)
         VALUES ($1, NULL, $2, 'engineer', 10000000, 'USD', 'active')`,
        [company.id, `nameless-${Date.now()}@example.com`],
      )
      .catch((e: unknown) => e);

    expect(pgErrorCode(error)).toBe(PG_NOT_NULL_VIOLATION);

    await db.delete(companies).where(eq(companies.id, company.id));
  });
});

describe("CHECK restricts values, not transitions", () => {
  it("does NOT stop a terminated employee from being reactivated (terminated -> active)", async () => {
    const company = await insertTestCompany("Transition Co");
    const email = `transition-${Date.now()}@example.com`;

    const [hired] = await db
      .insert(employees)
      .values({
        companyId: company.id,
        fullName: "Transition Employee",
        email,
        role: "engineer",
        annualSalaryCents: 10_000_000,
        currency: "USD",
        employmentStatus: "terminated",
      })
      .returning();

    expect(hired!.employmentStatus).toBe("terminated");

    // 'active' is a member of the allowed value set, so the CHECK constraint
    // has nothing to say about whether this specific transition makes
    // business sense - it happily allows it.
    await expect(
      db.update(employees).set({ employmentStatus: "active" }).where(eq(employees.id, hired!.id)),
    ).resolves.not.toThrow();

    const [reactivated] = await db.select().from(employees).where(eq(employees.id, hired!.id));
    expect(reactivated!.employmentStatus).toBe("active");

    await db.delete(employees).where(eq(employees.id, hired!.id));
    await db.delete(companies).where(eq(companies.id, company.id));
  });
});
