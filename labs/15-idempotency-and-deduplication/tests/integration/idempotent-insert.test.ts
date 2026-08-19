import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runConcurrently } from "@labs/test-utils";
import { db, pool as migratePool } from "../../src/db/client.js";
import { performIdempotentPaymentAttempt } from "../../src/scenarios/idempotent-insert.js";
import { countPaymentsFor, scenarioPayee } from "../../src/scenarios/payment-utils.js";

beforeAll(async () => {
  await waitForDatabase(migratePool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await migratePool.end();
});

describe("idempotent payment insert (UNIQUE idempotency_key + ON CONFLICT DO NOTHING + fetch-cached-result)", () => {
  it("happy path: a single attempt inserts exactly one row and reports wasNewlyInserted=true", async () => {
    const payee = scenarioPayee("Idempotent Happy Path");
    const amountCents = 1_500;
    const idempotencyKey = randomUUID();

    const result = await performIdempotentPaymentAttempt(migratePool, { idempotencyKey, amountCents, payee });

    expect(result.wasNewlyInserted).toBe(true);
    const rowCount = await countPaymentsFor(migratePool, payee, amountCents);
    expect(rowCount).toBe(1);
  });

  it("a sequential retry with the SAME key does not insert a second row and returns the identical row", async () => {
    const payee = scenarioPayee("Idempotent Sequential Retry");
    const amountCents = 2_000;
    const idempotencyKey = randomUUID();

    const first = await performIdempotentPaymentAttempt(migratePool, { idempotencyKey, amountCents, payee });
    const retry = await performIdempotentPaymentAttempt(migratePool, { idempotencyKey, amountCents, payee });

    expect(first.wasNewlyInserted).toBe(true);
    expect(retry.wasNewlyInserted).toBe(false);
    expect(retry.row.id).toBe(first.row.id);
    expect(retry.row.public_id).toBe(first.row.public_id);
    expect(retry.row.amount_cents).toBe(first.row.amount_cents);

    const rowCount = await countPaymentsFor(migratePool, payee, amountCents);
    expect(rowCount).toBe(1);
  });

  /**
   * The invariant per SPEC.md section 11 / CLAUDE.md: assert on the real row
   * count after real concurrency, not on execution order. One real
   * connection per attempt (a pool with enough headroom that every attempt
   * can actually run at once, not queue behind a small pool) so the UNIQUE
   * constraint + ON CONFLICT DO NOTHING genuinely has to resolve a race, not
   * just serialize requests that never truly overlapped.
   */
  it("N concurrent retries with the SAME idempotency key produce EXACTLY 1 row", async () => {
    const racePool = createPool({ connectionString: process.env.DATABASE_URL, max: 50 });
    try {
      const payee = scenarioPayee("Idempotent Concurrent Retry");
      const amountCents = 4_500;
      const idempotencyKey = randomUUID();
      const CONCURRENCY = 25;

      const results = await runConcurrently(CONCURRENCY, () =>
        performIdempotentPaymentAttempt(racePool, { idempotencyKey, amountCents, payee }),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled).toHaveLength(CONCURRENCY);

      const rowCount = await countPaymentsFor(migratePool, payee, amountCents);
      expect(rowCount).toBe(1);

      const newlyInsertedCount = fulfilled.filter(
        (r) => r.status === "fulfilled" && r.value.wasNewlyInserted,
      ).length;
      expect(newlyInsertedCount).toBe(1);

      /**
       * The part naive tests often skip: not just "not duplicated" but
       * "every single caller received the identical response" - same row
       * id, same public_id, same amount. This is the real idempotency
       * contract (see idempotent-insert.ts's docstring): a retry must get
       * back what the FIRST call would have returned, not merely avoid a
       * second row.
       */
      const rowIds = new Set(fulfilled.map((r) => (r.status === "fulfilled" ? r.value.row.id : undefined)));
      const publicIds = new Set(
        fulfilled.map((r) => (r.status === "fulfilled" ? r.value.row.public_id : undefined)),
      );
      const amounts = new Set(
        fulfilled.map((r) => (r.status === "fulfilled" ? r.value.row.amount_cents : undefined)),
      );
      const payees = new Set(fulfilled.map((r) => (r.status === "fulfilled" ? r.value.row.payee : undefined)));

      expect(rowIds.size).toBe(1);
      expect(publicIds.size).toBe(1);
      expect(amounts.size).toBe(1);
      expect(payees.size).toBe(1);
    } finally {
      await racePool.end();
    }
  });
});
