import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { actualOrderCounts, runNaiveRevenueReport } from "../../src/scenarios/naive-report.js";
import { runCorrectedRevenueReport } from "../../src/scenarios/corrected-report.js";
import { seedTestData } from "./seed-helper.js";

/**
 * This is the invariant test behind this lab's "Break it" / "Fix it": the
 * naive report's order count must NOT be trusted (it should disagree with
 * the ground truth for at least one customer with a multi-line order), and
 * the corrected report's order count must always agree with the ground
 * truth, for every customer, every time.
 */
beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await seedTestData();
});

afterAll(async () => {
  await pool.end();
});

describe("join fan-out bug", () => {
  it("naive report inflates order_count for at least one customer with a multi-line order", async () => {
    const rows = await runNaiveRevenueReport(30);
    const actual = await actualOrderCounts(rows.map((r) => r.customerId));

    const anyInflated = rows.some((row) => row.reportedOrderCount !== (actual.get(row.customerId) ?? 0));

    expect(rows.length).toBeGreaterThan(0);
    expect(anyInflated).toBe(true);
  });

  it("corrected report's order_count matches the ground truth for every customer", async () => {
    const rows = await runCorrectedRevenueReport(30);
    const actual = await actualOrderCounts(rows.map((r) => r.customerId));

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.orderCount).toBe(actual.get(row.customerId) ?? 0);
    }
  });

  it("naive and corrected reports still agree on revenue (SUM is not affected by the fan-out)", async () => {
    const naiveRows = await runNaiveRevenueReport(30);
    const correctedRows = await runCorrectedRevenueReport(30);

    const correctedByCustomer = new Map(correctedRows.map((r) => [r.customerId, r.revenueCents]));

    for (const naiveRow of naiveRows) {
      expect(String(correctedByCustomer.get(naiveRow.customerId))).toBe(String(naiveRow.revenueCents));
    }
  });
});
