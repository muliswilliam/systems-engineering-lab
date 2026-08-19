import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { getAccountBalanceCents } from "./balance-utils.js";
import { makeCreditAppliedMessage, sleep, type CreditAppliedMessage } from "./message.js";

const log = createLogger("lab18:scenario:racy");

export type RacyOutcome =
  | { outcome: "applied"; workerId: string }
  | { outcome: "skipped-already-processed"; workerId: string }
  | { outcome: "applied-but-insert-conflicted"; workerId: string; pgErrorCode: string | undefined };

/**
 * THE SUBTLER, STILL-BROKEN CONSUMER.
 *
 * This one DOES consult `processed_messages` first, and only applies the
 * effect if the message looks new - but the check, the effect, and the
 * insert are three separate statements on the connection, not one atomic
 * transaction. `delayMs` (default 0) is an artificial pause inserted
 * between "checked, not found" and "apply the effect" - per CLAUDE.md's
 * "delays only when needed to make the race observable," this widens the
 * window so two truly concurrent redeliveries reliably both pass the check
 * before either one writes anything, instead of relying on both processes
 * happening to be scheduled within microseconds of each other.
 *
 * Notice what happens to the SECOND writer once the delay elapses: its
 * `UPDATE accounts` still runs (the harmful effect is already applied by
 * the time anything looks at `processed_messages` again), and only its
 * final `INSERT INTO processed_messages` fails, with a real Postgres
 * unique-violation (`23505`) on the `message_id` primary key - because
 * that table's own integrity is protected by a real constraint. The
 * business effect it exists to guard is not, because the guard and the
 * effect are not atomic together.
 */
export async function applyRacy(
  pool: Pool,
  message: CreditAppliedMessage,
  workerId: string,
  delayMs = 0,
): Promise<RacyOutcome> {
  const client = await pool.connect();
  try {
    const existing = await client.query("SELECT 1 FROM processed_messages WHERE message_id = $1", [
      message.messageId,
    ]);
    if ((existing.rowCount ?? 0) > 0) {
      return { outcome: "skipped-already-processed", workerId };
    }

    if (delayMs > 0) {
      // The race window: both workers can reach this point having each seen
      // "not found" above, before either one has written anything back.
      await sleep(delayMs);
    }

    await client.query("UPDATE accounts SET balance_cents = balance_cents + $1 WHERE id = $2", [
      message.amountCents,
      message.accountId,
    ]);

    try {
      await client.query(
        "INSERT INTO processed_messages (message_id, account_id, amount_cents) VALUES ($1, $2, $3)",
        [message.messageId, message.accountId, message.amountCents],
      );
      return { outcome: "applied", workerId };
    } catch (error) {
      const pgErrorCode = (error as { code?: string }).code;
      // The dedup table's own PRIMARY KEY is real and rejects the second
      // insert (23505 = unique_violation) - but the UPDATE two lines above
      // already committed on this connection (autocommit, no BEGIN here).
      // The effect is done; only the bookkeeping insert failed.
      return { outcome: "applied-but-insert-conflicted", workerId, pgErrorCode };
    }
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const accountResult = await pool.query<{ id: number }>("SELECT id FROM accounts ORDER BY id LIMIT 1");
  const account = accountResult.rows[0];
  if (!account) {
    throw new Error("Need at least 1 account - run `pnpm seed` first");
  }

  const amountCents = 3_000; // $30.00
  const message = makeCreditAppliedMessage(account.id, amountCents);
  const balanceBefore = await getAccountBalanceCents(pool, account.id);

  log.info(
    { messageId: message.messageId, accountId: account.id, amountCents },
    "delivering the SAME message to two workers CONCURRENTLY, with a 50ms check-to-insert delay",
  );

  const [resultA, resultB] = await Promise.all([
    applyRacy(pool, message, "worker-a", 50),
    applyRacy(pool, message, "worker-b", 50),
  ]);

  const balanceAfter = await getAccountBalanceCents(pool, account.id);
  const expectedIfExactlyOnce = balanceBefore + amountCents;

  log.warn(
    {
      messageId: message.messageId,
      accountId: account.id,
      amountCents,
      resultA,
      resultB,
      balanceBefore,
      balanceAfter,
      expectedIfExactlyOnce,
      overchargedCents: balanceAfter - expectedIfExactlyOnce,
    },
    balanceAfter !== expectedIfExactlyOnce
      ? "BUG: both concurrent deliveries passed the 'not found' check and both applied the effect - the dedup table's own unique constraint only stopped the second bookkeeping INSERT, not the double UPDATE"
      : "unexpected: balance matches exactly-once despite the concurrent redelivery",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "racy scenario failed");
    process.exit(1);
  });
}
