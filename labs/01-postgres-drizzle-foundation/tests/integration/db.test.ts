import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { companies, employees } from "../../src/db/schema.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

describe("schema foundations", () => {
  it("inserts a company and generates a public UUID", async () => {
    const [inserted] = await db
      .insert(companies)
      .values({ name: "Test Co", country: "United States", currency: "USD" })
      .returning();

    expect(inserted).toBeDefined();
    expect(inserted!.publicId).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserted!.id).toBeGreaterThan(0);

    await db.delete(companies).where(eq(companies.id, inserted!.id));
  });

  it("enforces the employee -> company foreign key", async () => {
    await expect(
      db.insert(employees).values({
        companyId: 999_999_999,
        fullName: "Nobody",
        email: `nobody-${Date.now()}@example.com`,
        role: "engineer",
        annualSalaryCents: 10_000_000,
        currency: "USD",
      }),
    ).rejects.toThrow();
  });

  it("enforces a unique employee email", async () => {
    const [company] = await db
      .insert(companies)
      .values({ name: "Unique Email Co", country: "United States", currency: "USD" })
      .returning();

    const email = `dup-${Date.now()}@example.com`;

    await db.insert(employees).values({
      companyId: company!.id,
      fullName: "First",
      email,
      role: "engineer",
      annualSalaryCents: 10_000_000,
      currency: "USD",
    });

    await expect(
      db.insert(employees).values({
        companyId: company!.id,
        fullName: "Second",
        email,
        role: "engineer",
        annualSalaryCents: 10_000_000,
        currency: "USD",
      }),
    ).rejects.toThrow();

    await db.delete(employees).where(eq(employees.companyId, company!.id));
    await db.delete(companies).where(eq(companies.id, company!.id));
  });
});
