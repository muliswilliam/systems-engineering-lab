import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runConcurrently } from "@labs/test-utils";
import { db, pool as migratePool } from "../../src/db/client.js";
import { performCachedResultPaymentAttempt } from "../../src/scenarios/cached-result-pattern.js";
import { countPaymentsFor, scenarioPayee } from "../../src/scenarios/payment-utils.js";

beforeAll(async () => {
  await waitForDatabase(migratePool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await migratePool.end();
});

describe("cached result pattern (idempotent insert + a non-deterministic computed result)", () => {
  it("a sequential retry receives the ORIGINAL confirmation code and fee, not a recomputed one", async () => {
    const payee = scenarioPayee("Cached Result Sequential");
    const amountCents = 5_000;
    const idempotencyKey = randomUUID();

    const first = await performCachedResultPaymentAttempt(migratePool, { idempotencyKey, amountCents, payee });
    const retry = await performCachedResultPaymentAttempt(migratePool, { idempotencyKey, amountCents, payee });

    expect(first.wasNewlyInserted).toBe(true);
    expect(retry.wasNewlyInserted).toBe(false);

    // The persisted, returned-to-caller result is identical across both calls.
    expect(retry.row.confirmation_code).toBe(first.row.confirmation_code);
    expect(retry.row.processing_fee_cents).toBe(first.row.processing_fee_cents);

    // But what the retry call computed LOCALLY (before discovering the
    // conflict) is essentially certain to differ - proving the function
    // actually discarded a freshly-computed result rather than never
    // computing one at all.
    expect(retry.locallyComputed.confirmationCode).not.toBe(first.locallyComputed.confirmationCode);
  });

  /**
   * The concurrent version of the same fact, and the part a naive test would
   * skip: assert response equality across every caller, not just that one
   * row exists. Each of the N concurrent callers independently ran the
   * "processor" and computed its own confirmation code/fee - only one of
   * those N computed results should ever reach the database, and every
   * caller (including the ones whose own computation was discarded) must
   * receive that SAME persisted result back.
   */
  it("N concurrent retries produce exactly 1 row and EVERY caller receives the identical persisted result", async () => {
    const racePool = createPool({ connectionString: process.env.DATABASE_URL, max: 50 });
    try {
      const payee = scenarioPayee("Cached Result Concurrent");
      const amountCents = 7_500;
      const idempotencyKey = randomUUID();
      const CONCURRENCY = 25;

      const results = await runConcurrently(CONCURRENCY, () =>
        performCachedResultPaymentAttempt(racePool, { idempotencyKey, amountCents, payee }),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled).toHaveLength(CONCURRENCY);

      const rowCount = await countPaymentsFor(migratePool, payee, amountCents);
      expect(rowCount).toBe(1);

      const newlyInsertedCount = fulfilled.filter(
        (r) => r.status === "fulfilled" && r.value.wasNewlyInserted,
      ).length;
      expect(newlyInsertedCount).toBe(1);

      const persistedConfirmationCodes = new Set(
        fulfilled.map((r) => (r.status === "fulfilled" ? r.value.row.confirmation_code : undefined)),
      );
      const persistedFees = new Set(
        fulfilled.map((r) => (r.status === "fulfilled" ? r.value.row.processing_fee_cents : undefined)),
      );
      // All N callers agree on the persisted result: exactly one distinct
      // value across all of them.
      expect(persistedConfirmationCodes.size).toBe(1);
      expect(persistedFees.size).toBe(1);

      // And yet every one of the N callers independently computed its OWN
      // confirmation code before finding out about the conflict - proof this
      // is genuinely a "discard the redundant computation" pattern, not a
      // "only the first caller ever computes anything" one.
      const locallyComputedCodes = new Set(
        fulfilled.map((r) => (r.status === "fulfilled" ? r.value.locallyComputed.confirmationCode : undefined)),
      );
      expect(locallyComputedCodes.size).toBe(CONCURRENCY);
    } finally {
      await racePool.end();
    }
  });
});
