import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { countFulfilled, runConcurrently } from "@labs/test-utils";
import { db, pool as migratePool } from "../../src/db/client.js";
import { performNaivePaymentAttempt } from "../../src/scenarios/naive-retry.js";
import { countPaymentsFor, scenarioPayee } from "../../src/scenarios/payment-utils.js";

beforeAll(async () => {
  await waitForDatabase(migratePool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await migratePool.end();
});

/**
 * Per CLAUDE.md's "show failure before the fix," this file proves the bug is
 * real - actual duplicate rows in a real Postgres table under real
 * concurrency - not just narrated in the README.
 */
describe("naive payment insert (no ON CONFLICT, no dedup discipline)", () => {
  it("happy path: a single attempt inserts exactly one row", async () => {
    const payee = scenarioPayee("Naive Happy Path");
    const amountCents = 1_500;

    const result = await performNaivePaymentAttempt(migratePool, {
      idempotencyKey: randomUUID(),
      amountCents,
      payee,
    });

    // `id` is a bigint column; node-postgres returns bigint values as
    // strings by default to avoid silent precision loss above 2^53.
    expect(Number(result.id)).toBeGreaterThan(0);
    const rowCount = await countPaymentsFor(migratePool, payee, amountCents);
    expect(rowCount).toBe(1);
  });

  /**
   * The real-world scenario: a client sends a charge request, the response
   * is lost, and the client's retry logic resends the exact same logical
   * request. Fired CONCURRENTLY (via one connection per attempt, not a
   * shared pool awaited sequentially) so this isn't just "two sequential
   * calls" - it proves there is no protection even when retries race each
   * other, which is realistic for a client that fires a retry immediately
   * after a timeout while the original request might still be in flight.
   */
  it("CORRUPTS the invariant: N concurrent retries with NO idempotency key produce N rows for one logical payment", async () => {
    const racePool = createPool({ connectionString: process.env.DATABASE_URL, max: 50 });
    try {
      const payee = scenarioPayee("Naive No-Key Race");
      const amountCents = 2_500;
      const CONCURRENCY = 25;

      const results = await runConcurrently(CONCURRENCY, () =>
        performNaivePaymentAttempt(racePool, { idempotencyKey: null, amountCents, payee }),
      );

      expect(countFulfilled(results)).toBe(CONCURRENCY);

      const rowCount = await countPaymentsFor(migratePool, payee, amountCents);
      // The real, measured fact: one logical payment now has as many rows as
      // there were concurrent retries - a real double (N-tuple) charge.
      expect(rowCount).toBe(CONCURRENCY);
    } finally {
      await racePool.end();
    }
  });

  /**
   * A more realistic variant of the same bug: the client DOES generate an
   * idempotency key, but its retry path generates a NEW one on every
   * attempt instead of reusing the key from the original request. Even
   * though `idempotency_key` carries a UNIQUE constraint (see
   * src/db/schema.ts), the constraint never fires, because every key really
   * is a distinct value - a unique constraint cannot deduplicate values it
   * was never given a reason to compare as equal.
   */
  it("provides NO PROTECTION when each retry generates its own fresh idempotency key", async () => {
    const racePool = createPool({ connectionString: process.env.DATABASE_URL, max: 50 });
    try {
      const payee = scenarioPayee("Naive Fresh-Key Race");
      const amountCents = 3_500;
      const CONCURRENCY = 25;

      const results = await runConcurrently(CONCURRENCY, () =>
        performNaivePaymentAttempt(racePool, {
          idempotencyKey: randomUUID(), // bug: fresh key per attempt, not reused
          amountCents,
          payee,
        }),
      );

      expect(countFulfilled(results)).toBe(CONCURRENCY);

      const rowCount = await countPaymentsFor(migratePool, payee, amountCents);
      expect(rowCount).toBe(CONCURRENCY);
    } finally {
      await racePool.end();
    }
  });
});
