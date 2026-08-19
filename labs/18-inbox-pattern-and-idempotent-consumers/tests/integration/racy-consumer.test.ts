import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { applyRacy } from "../../src/scenarios/racy-check-then-insert-consumer.js";
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

describe("racy check-then-insert consumer (dedup check present, but not atomic with the effect)", () => {
  it("sequential redelivery is actually fine: the 2nd delivery finds the row and skips", async () => {
    const account = await insertAccount("Racy Sequential", 10_000);
    const amountCents = 1_000;
    const message = makeCreditAppliedMessage(account.id, amountCents);
    const balanceBefore = await getAccountBalanceCents(pool, account.id);

    const first = await applyRacy(pool, message, "worker-1");
    const second = await applyRacy(pool, message, "worker-2");

    expect(first.outcome).toBe("applied");
    expect(second.outcome).toBe("skipped-already-processed");

    const balanceAfter = await getAccountBalanceCents(pool, account.id);
    expect(balanceAfter).toBe(balanceBefore + amountCents);

    await cleanupAccount(account.id);
  });

  /**
   * The subtler bug: two workers process the SAME redelivered message at
   * the same instant over two separate real connections. Per CLAUDE.md's
   * "delays only when needed to make the race observable," a small
   * artificial delay is inserted between "checked, not found" and "apply
   * the effect" inside applyRacy - this widens the race window so both
   * concurrent calls reliably observe "not found" before either one writes
   * anything, rather than depending on both processes happening to be
   * scheduled within microseconds of each other. Without any delay this
   * race can still occur, but is not reliable enough for a deterministic
   * test; 50ms was more than enough to reproduce it on every run measured
   * during this lab's validation (see README "Break it").
   */
  it("BUG: the same message delivered CONCURRENTLY can be double-applied despite the dedup check", async () => {
    const account = await insertAccount("Racy Concurrent", 10_000);
    const amountCents = 1_500;
    const message = makeCreditAppliedMessage(account.id, amountCents);
    const balanceBefore = await getAccountBalanceCents(pool, account.id);

    const [resultA, resultB] = await Promise.all([
      applyRacy(pool, message, "worker-a", 50),
      applyRacy(pool, message, "worker-b", 50),
    ]);

    const balanceAfter = await getAccountBalanceCents(pool, account.id);

    // Both workers applied the effect - one via a clean INSERT, the other
    // via an UPDATE that ran successfully before its own bookkeeping INSERT
    // hit the processed_messages primary key and conflicted.
    const outcomes = [resultA.outcome, resultB.outcome].sort();
    expect(outcomes).toEqual(["applied", "applied-but-insert-conflicted"]);

    const conflicted = [resultA, resultB].find((r) => r.outcome === "applied-but-insert-conflicted");
    expect(conflicted).toBeDefined();
    if (conflicted && conflicted.outcome === "applied-but-insert-conflicted") {
      expect(conflicted.pgErrorCode).toBe("23505"); // unique_violation
    }

    // The actual invariant violation: the account was credited twice for
    // one logical event, exactly like the naive consumer.
    expect(balanceAfter).toBe(balanceBefore + amountCents * 2);
    expect(balanceAfter).not.toBe(balanceBefore + amountCents);

    // The dedup table's OWN integrity is fine - exactly one row exists for
    // this message_id, because its PRIMARY KEY genuinely rejected the
    // second insert. That constraint just wasn't atomic with the effect it
    // was supposed to guard.
    const processedCount = await countProcessedMessages(pool, message.messageId);
    expect(processedCount).toBe(1);

    await cleanupAccount(account.id);
  });
});
