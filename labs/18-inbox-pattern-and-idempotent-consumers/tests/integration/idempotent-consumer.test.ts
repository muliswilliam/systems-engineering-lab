import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { runConcurrently } from "@labs/test-utils";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { applyIdempotent } from "../../src/scenarios/idempotent-consumer.js";
import { countProcessedMessages, getAccountBalanceCents } from "../../src/scenarios/balance-utils.js";
import { makeCreditAppliedMessage } from "../../src/scenarios/message.js";
import { cleanupAccount, insertAccount } from "./account-helpers.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

describe("idempotent consumer (dedup check/insert + effect, one atomic transaction)", () => {
  it("applies a sequentially-redelivered message's effect exactly once", async () => {
    const account = await insertAccount("Idempotent Sequential", 10_000);
    const amountCents = 1_000;
    const message = makeCreditAppliedMessage(account.id, amountCents);
    const balanceBefore = await getAccountBalanceCents(pool, account.id);

    const first = await applyIdempotent(pool, message, "worker-1");
    const balanceAfterFirst = await getAccountBalanceCents(pool, account.id);

    const second = await applyIdempotent(pool, message, "worker-2");
    const balanceAfterSecond = await getAccountBalanceCents(pool, account.id);

    expect(first.outcome).toBe("applied");
    expect(second.outcome).toBe("duplicate");
    expect(balanceAfterFirst).toBe(balanceBefore + amountCents);
    // The invariant: the SECOND delivery must change nothing.
    expect(balanceAfterSecond).toBe(balanceAfterFirst);

    const processedCount = await countProcessedMessages(pool, message.messageId);
    expect(processedCount).toBe(1);

    await cleanupAccount(account.id);
  });

  /**
   * The important test: N workers deliver the IDENTICAL message at the same
   * instant over N separate real connections (via runConcurrently, per
   * SPEC.md section 11 - "100 concurrent reservation attempts -> exactly 1
   * successful reservation" is the template this test follows). Unlike the
   * racy consumer, this must hold under REAL concurrency, not just
   * sequential redelivery - the guarantee comes from Postgres's own
   * PRIMARY KEY conflict resolution on `processed_messages.message_id`,
   * which serializes the competing INSERTs regardless of how the
   * application code happens to be scheduled.
   */
  it("applies a CONCURRENTLY-redelivered message's effect exactly once even under real concurrent delivery", async () => {
    const account = await insertAccount("Idempotent Concurrent", 10_000);
    const amountCents = 1_750;
    const message = makeCreditAppliedMessage(account.id, amountCents);
    const balanceBefore = await getAccountBalanceCents(pool, account.id);

    const WORKER_COUNT = 20;
    const results = await runConcurrently(WORKER_COUNT, (i) => applyIdempotent(pool, message, `worker-${i}`));

    const fulfilled = results.map((r) => {
      if (r.status !== "fulfilled") {
        throw r.reason;
      }
      return r.value;
    });

    const appliedCount = fulfilled.filter((r) => r.outcome === "applied").length;
    const duplicateCount = fulfilled.filter((r) => r.outcome === "duplicate").length;

    // Exactly one of the 20 concurrent deliveries actually applied the
    // effect - not "usually one," not "approximately one."
    expect(appliedCount).toBe(1);
    expect(duplicateCount).toBe(WORKER_COUNT - 1);

    const balanceAfter = await getAccountBalanceCents(pool, account.id);
    expect(balanceAfter).toBe(balanceBefore + amountCents);

    const processedCount = await countProcessedMessages(pool, message.messageId);
    expect(processedCount).toBe(1);

    await cleanupAccount(account.id);
  });
});
