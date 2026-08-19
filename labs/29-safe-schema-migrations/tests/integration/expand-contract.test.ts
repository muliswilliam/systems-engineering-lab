import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { customers } from "../../src/db/schema.js";
import {
  applyExpandStep,
  backfillDisplayName,
  dualWriteInsertCustomer,
  readDisplayName,
} from "../../src/scenarios/expand-contract-migration.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

/**
 * Each test inserts its own scratch customer row(s) rather than relying on
 * the shared seeded dataset, the same isolation rationale as Lab 05's
 * account-helpers.ts - correctness here means "this specific row, which I
 * know the history of, ends up right," not "some aggregate count changed."
 */
describe("expand/contract migration: full_name -> display_name", () => {
  it("phase (a) ADD COLUMN IF NOT EXISTS is idempotent and near-instant regardless of table size", async () => {
    const { durationMs } = await applyExpandStep(pool);
    expect(durationMs).toBeLessThan(500);
  });

  it("backfills a pre-existing row (written before dual-write code existed) and it becomes correctly readable from display_name", async () => {
    const [preExisting] = await db
      .insert(customers)
      .values({
        fullName: "Backfill Cohort Row",
        email: `backfill-${Date.now()}@example.com`,
        country: "Canada",
      })
      .returning();

    expect(preExisting!.displayName).toBeNull();

    const backfill = await backfillDisplayName(pool, 200);
    expect(backfill.rowsBackfilled).toBeGreaterThanOrEqual(1);
    expect(backfill.batches).toBeGreaterThanOrEqual(1);

    const displayName = await readDisplayName(pool, preExisting!.id);
    expect(displayName).toBe("Backfill Cohort Row");

    await db.delete(customers).where(eq(customers.id, preExisting!.id));
  });

  it("a dual-written row is correctly readable from display_name immediately, with no backfill involved", async () => {
    const inserted = await dualWriteInsertCustomer(pool, {
      fullName: "Dual Write Cohort Row",
      email: `dualwrite-${Date.now()}@example.com`,
      country: "Germany",
    });

    const displayName = await readDisplayName(pool, inserted.id);
    expect(displayName).toBe("Dual Write Cohort Row");

    await db.delete(customers).where(eq(customers.id, inserted.id));
  });

  it("the invariant: after the full sequence, both a backfilled row and a dual-written row read correctly from display_name in the same pass", async () => {
    const [preExisting] = await db
      .insert(customers)
      .values({
        fullName: "Combined Backfill Row",
        email: `combined-backfill-${Date.now()}@example.com`,
        country: "France",
      })
      .returning();
    const dualWritten = await dualWriteInsertCustomer(pool, {
      fullName: "Combined Dual Write Row",
      email: `combined-dualwrite-${Date.now()}@example.com`,
      country: "United Kingdom",
    });

    await backfillDisplayName(pool, 200);

    const backfilledDisplayName = await readDisplayName(pool, preExisting!.id);
    const dualWrittenDisplayName = await readDisplayName(pool, dualWritten.id);

    expect(backfilledDisplayName).toBe("Combined Backfill Row");
    expect(dualWrittenDisplayName).toBe("Combined Dual Write Row");

    await db.delete(customers).where(eq(customers.id, preExisting!.id));
    await db.delete(customers).where(eq(customers.id, dualWritten.id));
  });

  it("backfill is resumable: rerunning it only touches rows still at display_name IS NULL", async () => {
    const rows = await db
      .insert(customers)
      .values([
        {
          fullName: "Resumable A",
          email: `resumable-a-${Date.now()}@example.com`,
          country: "United States",
        },
        {
          fullName: "Resumable B",
          email: `resumable-b-${Date.now()}@example.com`,
          country: "United States",
        },
      ])
      .returning();
    const [rowA, rowB] = rows;

    // Simulate "a previous backfill run already handled this row" with a
    // sentinel value a fresh backfill would never produce (it would only
    // ever copy full_name verbatim) - if the resumable backfill wrongly
    // re-touches this row, this assertion below catches it immediately.
    await db
      .update(customers)
      .set({ displayName: "ALREADY BACKFILLED - DO NOT TOUCH" })
      .where(eq(customers.id, rowA!.id));

    await backfillDisplayName(pool, 200);

    const untouched = await readDisplayName(pool, rowA!.id);
    const freshlyBackfilled = await readDisplayName(pool, rowB!.id);

    expect(untouched).toBe("ALREADY BACKFILLED - DO NOT TOUCH");
    expect(freshlyBackfilled).toBe("Resumable B");

    await db.delete(customers).where(eq(customers.id, rowA!.id));
    await db.delete(customers).where(eq(customers.id, rowB!.id));
  });
});
