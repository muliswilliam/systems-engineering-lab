import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { accounts, processedMessages } from "../../src/db/schema.js";

/**
 * Each test constructs its own scratch account with a known starting
 * balance, the same pattern Lab 05's account-helpers.ts uses - exact
 * before/after balance arithmetic is far clearer against an account a test
 * created itself than against rows shared with every other test in the
 * file.
 */
export async function insertAccount(ownerName: string, balanceCents: number) {
  const [account] = await db
    .insert(accounts)
    .values({ ownerName, balanceCents, currency: "USD" })
    .returning();
  return account!;
}

/** Deletes an account's processed_messages rows before the account itself,
 * respecting the `processed_messages.account_id` foreign key. */
export async function cleanupAccount(accountId: number): Promise<void> {
  await db.delete(processedMessages).where(eq(processedMessages.accountId, accountId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
}
