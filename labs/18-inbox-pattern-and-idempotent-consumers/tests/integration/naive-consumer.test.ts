import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { applyNaive } from "../../src/scenarios/naive-consumer.js";
import { getAccountBalanceCents } from "../../src/scenarios/balance-utils.js";
import { makeCreditAppliedMessage, redeliver } from "../../src/scenarios/message.js";
import { cleanupAccount, insertAccount } from "./account-helpers.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

/**
 * Proves the bug is real, not just narrated in the README - per CLAUDE.md's
 * "show failure before the fix," the naive consumer's double-application
 * must actually be observable in a test.
 */
describe("naive consumer (no dedup check at all)", () => {
  it("happy path: a single delivery credits the account exactly once", async () => {
    const account = await insertAccount("Naive Happy", 10_000);
    const message = makeCreditAppliedMessage(account.id, 1_500);

    await applyNaive(pool, message);

    const balance = await getAccountBalanceCents(pool, account.id);
    expect(balance).toBe(11_500);

    await cleanupAccount(account.id);
  });

  it("BUG: a redelivered message's effect is applied twice - final balance reflects 2x the credit amount", async () => {
    const account = await insertAccount("Naive Redelivered", 10_000);
    const amountCents = 2_000;
    const message = makeCreditAppliedMessage(account.id, amountCents);
    const [first, second] = redeliver(message, 2);
    const balanceBefore = await getAccountBalanceCents(pool, account.id);

    await applyNaive(pool, first!);
    await applyNaive(pool, second!);

    const balanceAfter = await getAccountBalanceCents(pool, account.id);

    // The invariant a correct consumer must uphold: one logical event, one
    // effect. The naive consumer violates it - this is the bug, captured as
    // an assertion, not a narrated claim.
    expect(balanceAfter).toBe(balanceBefore + amountCents * 2);
    expect(balanceAfter).not.toBe(balanceBefore + amountCents);

    await cleanupAccount(account.id);
  });
});
