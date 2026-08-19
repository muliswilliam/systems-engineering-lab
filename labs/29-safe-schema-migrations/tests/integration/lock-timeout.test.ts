import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import {
  runAlterTableWithLockTimeout,
  runAlterTableWithoutLockTimeout,
} from "../../src/scenarios/lock-timeout-fail-fast.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

describe("lock_timeout: fail fast instead of hanging behind a conflicting lock", () => {
  it("without lock_timeout, ALTER TABLE blocks for the full duration of the held lock, then succeeds", async () => {
    const idsResult = await pool.query<{ id: number }>("SELECT id FROM customers ORDER BY id LIMIT 1");
    const customerId = idsResult.rows[0]!.id;
    const holdMs = 800;

    const result = await runAlterTableWithoutLockTimeout(
      process.env.DATABASE_URL as string,
      customerId,
      holdMs,
      "test_col_no_timeout",
    );

    expect(result.succeeded).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(holdMs - 150);
  });

  it("with a short lock_timeout, ALTER TABLE fails fast with SQLSTATE 55P03 in under the lock_timeout duration plus a small margin", async () => {
    const idsResult = await pool.query<{ id: number }>("SELECT id FROM customers ORDER BY id LIMIT 1");
    const customerId = idsResult.rows[0]!.id;
    const holdMs = 1_500;
    const lockTimeoutMs = 400;

    const result = await runAlterTableWithLockTimeout(
      process.env.DATABASE_URL as string,
      customerId,
      holdMs,
      lockTimeoutMs,
      "test_col_with_timeout",
    );

    expect(result.succeeded).toBe(false);
    expect(result.errorCode).toBe("55P03");
    expect(result.errorMessage).toMatch(/lock timeout/);

    // Failed fast: close to the configured lock_timeout (plus a generous
    // margin for scheduling jitter), and well under the full hold duration -
    // it never joined the queue for the remaining ~1100ms of the held lock.
    expect(result.durationMs).toBeGreaterThanOrEqual(lockTimeoutMs - 100);
    expect(result.durationMs).toBeLessThan(lockTimeoutMs + 1_000);
    expect(result.durationMs).toBeLessThan(holdMs);
  });
});
