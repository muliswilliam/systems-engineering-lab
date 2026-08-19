import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { accounts, transfers } from "../../src/db/schema.js";
import { performTransactionalTransfer } from "../../src/scenarios/transactional-transfer.js";
import { getTotalBalanceCents } from "../../src/scenarios/balance-utils.js";
import { cleanupAccounts, insertAccount } from "./account-helpers.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

describe("transactional transfer (BEGIN ... COMMIT / ROLLBACK)", () => {
  it("happy path: source debited, destination credited, total preserved, status completed", async () => {
    const from = await insertAccount("Tx Happy From", 10_000);
    const to = await insertAccount("Tx Happy To", 5_000);
    const totalBefore = await getTotalBalanceCents(pool);

    const result = await performTransactionalTransfer(pool, {
      fromAccountId: from.id,
      toAccountId: to.id,
      amountCents: 2_000,
      injectFailureAfterDebit: false,
    });

    expect(result.committed).toBe(true);

    const totalAfter = await getTotalBalanceCents(pool);
    expect(totalAfter).toBe(totalBefore);

    const [updatedFrom] = await db.select().from(accounts).where(eq(accounts.id, from.id));
    const [updatedTo] = await db.select().from(accounts).where(eq(accounts.id, to.id));
    expect(updatedFrom!.balanceCents).toBe(8_000);
    expect(updatedTo!.balanceCents).toBe(7_000);

    const [transferRow] = await db.select().from(transfers).where(eq(transfers.id, result.transferId));
    expect(transferRow!.status).toBe("completed");

    await cleanupAccounts([from.id, to.id]);
  });

  it("failure path: ROLLBACK leaves source, destination, and total EXACTLY unchanged - this is atomicity", async () => {
    const from = await insertAccount("Tx Crash From", 10_000);
    const to = await insertAccount("Tx Crash To", 5_000);
    const amountCents = 2_000;
    const totalBefore = await getTotalBalanceCents(pool);

    const result = await performTransactionalTransfer(pool, {
      fromAccountId: from.id,
      toAccountId: to.id,
      amountCents,
      injectFailureAfterDebit: true,
    });

    expect(result.committed).toBe(false);

    // The whole-system invariant, preserved this time.
    const totalAfter = await getTotalBalanceCents(pool);
    expect(totalAfter).toBe(totalBefore);

    // Not "close to unchanged" or "eventually consistent" - byte-for-byte
    // identical to before the attempt, because ROLLBACK undid the debit
    // statement along with everything else since BEGIN.
    const [updatedFrom] = await db.select().from(accounts).where(eq(accounts.id, from.id));
    expect(updatedFrom!.balanceCents).toBe(10_000);

    const [updatedTo] = await db.select().from(accounts).where(eq(accounts.id, to.id));
    expect(updatedTo!.balanceCents).toBe(5_000);

    // The `pending` row inserted inside the rolled-back transaction is gone
    // - only the separate, post-rollback `failed` audit row exists.
    const rows = await db.select().from(transfers).where(eq(transfers.fromAccountId, from.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.failureReason).toContain("simulated crash");

    await cleanupAccounts([from.id, to.id]);
  });

  it("insufficient funds triggers a CHECK violation inside the transaction, which rolls back cleanly", async () => {
    const from = await insertAccount("Tx Poor From", 500);
    const to = await insertAccount("Tx Poor To", 500);
    const totalBefore = await getTotalBalanceCents(pool);

    const result = await performTransactionalTransfer(pool, {
      fromAccountId: from.id,
      toAccountId: to.id,
      amountCents: 10_000, // more than `from` has
      injectFailureAfterDebit: false,
    });

    expect(result.committed).toBe(false);
    if (!result.committed) {
      expect(result.reason).toMatch(/accounts_balance_cents_non_negative/);
    }

    const totalAfter = await getTotalBalanceCents(pool);
    expect(totalAfter).toBe(totalBefore);

    const [updatedFrom] = await db.select().from(accounts).where(eq(accounts.id, from.id));
    expect(updatedFrom!.balanceCents).toBe(500);

    await cleanupAccounts([from.id, to.id]);
  });

  /**
   * The core invariant test, per SPEC.md section 11 / CLAUDE.md: assert on
   * final state after a mixed sequence of attempts, not on execution order
   * or timing. A third of the attempts here are made to "crash"
   * deterministically; the total balance across the two accounts must be
   * identical before and after regardless of how many of the 30 attempts
   * succeeded and how many failed.
   */
  describe("invariant: total balance is preserved across a mixed sequence of successful and failed transfers", () => {
    it("holds after 30 transactional transfer attempts, some injected to fail", async () => {
      const a = await insertAccount("Invariant A", 100_000);
      const b = await insertAccount("Invariant B", 100_000);
      const totalBefore = await getTotalBalanceCents(pool);

      const ATTEMPTS = 30;
      const AMOUNT_CENTS = 250;
      let expectedCompleted = 0;
      let expectedFailed = 0;

      for (let i = 0; i < ATTEMPTS; i += 1) {
        const injectFailureAfterDebit = i % 3 === 0; // every 3rd attempt "crashes"
        const result = await performTransactionalTransfer(pool, {
          fromAccountId: a.id,
          toAccountId: b.id,
          amountCents: AMOUNT_CENTS,
          injectFailureAfterDebit,
        });
        if (result.committed) {
          expectedCompleted += 1;
        } else {
          expectedFailed += 1;
        }
      }

      expect(expectedCompleted).toBeGreaterThan(0);
      expect(expectedFailed).toBeGreaterThan(0);

      // The invariant: no matter how many of the 30 attempts failed, the
      // total balance across every account in the system is unchanged.
      const totalAfter = await getTotalBalanceCents(pool);
      expect(totalAfter).toBe(totalBefore);

      // A stronger, derived check: the accounts moved by exactly the sum of
      // the *successful* transfers, no more and no less.
      const [updatedA] = await db.select().from(accounts).where(eq(accounts.id, a.id));
      const [updatedB] = await db.select().from(accounts).where(eq(accounts.id, b.id));
      expect(updatedA!.balanceCents).toBe(100_000 - expectedCompleted * AMOUNT_CENTS);
      expect(updatedB!.balanceCents).toBe(100_000 + expectedCompleted * AMOUNT_CENTS);

      const completedRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(transfers)
        .where(and(eq(transfers.fromAccountId, a.id), eq(transfers.status, "completed")));
      expect(completedRows[0]!.count).toBe(expectedCompleted);

      const failedRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(transfers)
        .where(and(eq(transfers.fromAccountId, a.id), eq(transfers.status, "failed")));
      expect(failedRows[0]!.count).toBe(expectedFailed);

      // No 'pending' rows should ever survive a transactional attempt,
      // success or failure - unlike the naive mechanism.
      const pendingRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(transfers)
        .where(and(eq(transfers.fromAccountId, a.id), eq(transfers.status, "pending")));
      expect(pendingRows[0]!.count).toBe(0);

      await cleanupAccounts([a.id, b.id]);
    });
  });
});
