import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { getAccountBalanceCents } from "./balance-utils.js";
import { makeCreditAppliedMessage, redeliver, type CreditAppliedMessage } from "./message.js";

const log = createLogger("lab18:scenario:naive");

/**
 * THE NAIVE (BROKEN) CONSUMER.
 *
 * Applies a `CreditApplied` message's business effect with NO dedup check
 * at all - it does not know or care whether it has seen this `messageId`
 * before. Under at-least-once delivery (the reality Lab 17 demonstrates:
 * a crashed publisher retries, `SKIP LOCKED` claiming plus crash recovery
 * makes redelivery inevitable), the exact same message eventually arrives
 * twice, and this consumer credits the account twice for one logical event.
 */
export async function applyNaive(pool: Pool, message: CreditAppliedMessage): Promise<void> {
  await pool.query("UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2", [
    message.amountCents,
    message.accountId,
  ]);
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const accountResult = await pool.query<{ id: number }>("SELECT id FROM accounts ORDER BY id LIMIT 1");
  const account = accountResult.rows[0];
  if (!account) {
    throw new Error("Need at least 1 account - run `pnpm seed` first");
  }

  const amountCents = 2_500; // $25.00
  const message = makeCreditAppliedMessage(account.id, amountCents);
  const [first, second] = redeliver(message, 2);

  const balanceBefore = await getAccountBalanceCents(pool, account.id);

  log.info({ messageId: message.messageId, accountId: account.id, amountCents }, "delivering message (1st time)");
  await applyNaive(pool, first!);
  const balanceAfterFirst = await getAccountBalanceCents(pool, account.id);

  log.info(
    { messageId: message.messageId, accountId: account.id, amountCents },
    "REDELIVERING the identical message (2nd time) - simulating an at-least-once retry",
  );
  await applyNaive(pool, second!);
  const balanceAfterSecond = await getAccountBalanceCents(pool, account.id);

  const expectedIfExactlyOnce = balanceBefore + amountCents;

  log.warn(
    {
      messageId: message.messageId,
      accountId: account.id,
      amountCents,
      balanceBefore,
      balanceAfterFirstDelivery: balanceAfterFirst,
      balanceAfterSecondDelivery: balanceAfterSecond,
      expectedIfExactlyOnce,
      actual: balanceAfterSecond,
      overchargedCents: balanceAfterSecond - expectedIfExactlyOnce,
    },
    balanceAfterSecond !== expectedIfExactlyOnce
      ? "BUG: the account was credited twice for one logical event - no dedup check exists"
      : "unexpected: balance matches exactly-once even though the message was redelivered",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "naive scenario failed");
    process.exit(1);
  });
}
