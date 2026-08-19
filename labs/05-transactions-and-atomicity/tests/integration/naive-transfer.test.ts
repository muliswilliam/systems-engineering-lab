import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { accounts, transfers } from "../../src/db/schema.js";
import { performNaiveTransfer, SimulatedCrashError } from "../../src/scenarios/naive-transfer.js";
import { getTotalBalanceCents } from "../../src/scenarios/balance-utils.js";
import { cleanupAccounts, insertAccount } from "./account-helpers.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

/**
 * This file proves the bug is real, not just narrated in the README - per
 * CLAUDE.md's "show failure before the fix," the naive mechanism's
 * corruption must actually be observable in a test, not merely asserted in
 * prose.
 */
describe("naive transfer (two independent statements, no transaction)", () => {
  it("happy path: moves money correctly when nothing interrupts it", async () => {
    const from = await insertAccount("Naive Happy From", 10_000);
    const to = await insertAccount("Naive Happy To", 5_000);
    const totalBefore = await getTotalBalanceCents(pool);

    const result = await performNaiveTransfer(pool, {
      fromAccountId: from.id,
      toAccountId: to.id,
      amountCents: 2_000,
      injectFailureAfterDebit: false,
    });

    expect(result.debited).toBe(true);
    expect(result.credited).toBe(true);

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

  it("CORRUPTS the invariant: a crash between debit and credit makes money vanish", async () => {
    const from = await insertAccount("Naive Crash From", 10_000);
    const to = await insertAccount("Naive Crash To", 5_000);
    const amountCents = 2_000;
    const totalBefore = await getTotalBalanceCents(pool);

    let crash: SimulatedCrashError | undefined;
    try {
      await performNaiveTransfer(pool, {
        fromAccountId: from.id,
        toAccountId: to.id,
        amountCents,
        injectFailureAfterDebit: true,
      });
      expect.fail("expected performNaiveTransfer to throw SimulatedCrashError");
    } catch (error) {
      expect(error).toBeInstanceOf(SimulatedCrashError);
      crash = error as SimulatedCrashError;
    }

    // The whole-system invariant: total balance across every account must
    // never change just because a transfer was attempted. The naive
    // mechanism violates it - this is the bug, captured as an assertion.
    const totalAfter = await getTotalBalanceCents(pool);
    expect(totalAfter).toBe(totalBefore - amountCents);

    // The debit committed on its own...
    const [updatedFrom] = await db.select().from(accounts).where(eq(accounts.id, from.id));
    expect(updatedFrom!.balanceCents).toBe(8_000);

    // ...but the credit never happened - the destination is untouched. This
    // is "the whole point of atomicity": a failed operation must not apply
    // half of its effects.
    const [updatedTo] = await db.select().from(accounts).where(eq(accounts.id, to.id));
    expect(updatedTo!.balanceCents).toBe(5_000);

    // No code ran after the injected crash to mark the transfer failed - it
    // is stuck at 'pending' forever, which is itself part of the corruption
    // (a real system would need a separate reconciliation job to even
    // notice this transfer exists).
    const [transferRow] = await db.select().from(transfers).where(eq(transfers.id, crash!.transferId));
    expect(transferRow!.status).toBe("pending");

    await cleanupAccounts([from.id, to.id]);
  });

  it("insufficient funds rejects the debit statement itself, but still leaves an orphaned pending row", async () => {
    const from = await insertAccount("Naive Poor From", 500);
    const to = await insertAccount("Naive Poor To", 500);
    const totalBefore = await getTotalBalanceCents(pool);

    let pgErrorCode: string | undefined;
    try {
      await performNaiveTransfer(pool, {
        fromAccountId: from.id,
        toAccountId: to.id,
        amountCents: 10_000, // more than `from` has
        injectFailureAfterDebit: false,
      });
      expect.fail("expected performNaiveTransfer to reject with a CHECK violation");
    } catch (error) {
      pgErrorCode = (error as { code?: string }).code;
    }

    // A single UPDATE statement is atomic on its own - the
    // accounts_balance_cents_non_negative CHECK constraint rejects it
    // outright, so this specific failure mode does NOT corrupt anything.
    expect(pgErrorCode).toBe("23514");

    const totalAfter = await getTotalBalanceCents(pool);
    expect(totalAfter).toBe(totalBefore);

    const [updatedFrom] = await db.select().from(accounts).where(eq(accounts.id, from.id));
    expect(updatedFrom!.balanceCents).toBe(500);

    // The transfer row was still inserted as its own independent statement
    // before the debit was attempted, and nothing ever updates it after the
    // debit throws - another orphaned 'pending' row, for a different reason
    // than the crash case above.
    const [orphanedTransfer] = await db
      .select()
      .from(transfers)
      .where(eq(transfers.fromAccountId, from.id));
    expect(orphanedTransfer!.status).toBe("pending");

    await cleanupAccounts([from.id, to.id]);
  });
});
