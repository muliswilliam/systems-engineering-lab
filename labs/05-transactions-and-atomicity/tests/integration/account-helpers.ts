import { inArray, or } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { accounts, transfers } from "../../src/db/schema.js";

/**
 * Unlike Labs 03/04 (which share one large bulk-seeded dataset across every
 * test in a file via seed-helper.ts), this lab's tests each construct their
 * own small, isolated pair/set of scratch accounts with a known starting
 * balance. Atomicity tests need exact before/after balance arithmetic
 * (`expect(totalAfter).toBe(totalBefore - amountCents)`), which is far
 * clearer against accounts a test created itself than against rows shared
 * with every other test in the file.
 */
export async function insertAccount(ownerName: string, balanceCents: number) {
  const [account] = await db
    .insert(accounts)
    .values({ ownerName, balanceCents, currency: "USD" })
    .returning();
  return account!;
}

/** Deletes an account's transfers (as either side) before the account itself,
 * respecting the `transfers.from_account_id`/`to_account_id` foreign keys. */
export async function cleanupAccounts(accountIds: number[]): Promise<void> {
  await db
    .delete(transfers)
    .where(or(inArray(transfers.fromAccountId, accountIds), inArray(transfers.toAccountId, accountIds)));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
}
