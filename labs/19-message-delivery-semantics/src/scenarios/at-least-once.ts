import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { sendWithRetry, type SendWithRetryResult } from "../delivery/sender.js";
import { naiveProcessMessage } from "../delivery/receiver.js";
import {
  countDeliveryLogRows,
  getReceiverProcessedCount,
  insertNotification,
  recordDeliveryAttempt,
  setNotificationStatus,
} from "./query-utils.js";

const log = createLogger("lab19:scenario:at-least-once");

const RETRY = { maxAttempts: 5, backoffMs: (attempt: number) => attempt * 20 };

/**
 * AT-LEAST-ONCE, CASE (A): the message is dropped once, then the retry
 * succeeds. This is "the normal path" people picture when they hear
 * at-least-once - one lost attempt, one successful attempt, the receiver
 * genuinely only sees the message once, because the very attempt that
 * failed never reached the receiver in the first place.
 */
export async function runMessageLossThenSuccess(pool: Pool, recipient: string): Promise<{ messageId: number }> {
  const message = await insertNotification(pool, {
    recipient,
    body: "Your invoice is ready.",
    scenario: "at_least_once_message_loss",
  });

  const result: SendWithRetryResult = await sendWithRetry({
    script: { outcomes: ["message_lost", "success"] },
    retry: RETRY,
    deliverToReceiver: () => naiveProcessMessage(pool, message.id),
    onAttempt: (attempt) => recordDeliveryAttempt(pool, message.id, attempt),
  });
  await setNotificationStatus(pool, message.id, result.acked ? "delivered" : "undelivered");

  return { messageId: message.id };
}

/**
 * AT-LEAST-ONCE, CASE (B): the ACKNOWLEDGMENT is dropped, even though the
 * receiver genuinely received and processed the message on attempt 1. The
 * sender cannot tell "you never got it" apart from "you got it, I just
 * didn't hear back" - so it retries, and the receiver genuinely processes
 * the SAME message a second time. This - not message loss - is the real
 * mechanism by which at-least-once produces duplicates: the naive receiver
 * has no memory of attempt 1, so `naiveProcessMessage` runs twice.
 */
export async function runAckLoss(pool: Pool, recipient: string): Promise<{ messageId: number }> {
  const message = await insertNotification(pool, {
    recipient,
    body: "Your invoice is ready.",
    scenario: "at_least_once_ack_loss",
  });

  const result: SendWithRetryResult = await sendWithRetry({
    script: { outcomes: ["ack_lost", "success"] },
    retry: RETRY,
    deliverToReceiver: () => naiveProcessMessage(pool, message.id),
    onAttempt: (attempt) => recordDeliveryAttempt(pool, message.id, attempt),
  });
  await setNotificationStatus(pool, message.id, result.acked ? "delivered" : "undelivered");

  return { messageId: message.id };
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const marker = Date.now();

  log.info("--- (a) message-loss then success: the 'normal path' people assume ---");
  const a = await runMessageLossThenSuccess(pool, `msgloss-${marker}@example.com`);
  const aAttempts = await countDeliveryLogRows(pool, a.messageId);
  const aProcessed = await getReceiverProcessedCount(pool, a.messageId);
  log.info(
    { messageId: a.messageId, deliveryLogRows: aAttempts, receiverProcessedCount: aProcessed },
    "1 lost attempt + 1 successful attempt = 2 delivery_log rows, receiver saw it exactly once",
  );

  log.info("--- (b) ack-loss: the real mechanism that produces duplicates ---");
  const b = await runAckLoss(pool, `ackloss-${marker}@example.com`);
  const bAttempts = await countDeliveryLogRows(pool, b.messageId);
  const bProcessed = await getReceiverProcessedCount(pool, b.messageId);
  log.warn(
    { messageId: b.messageId, deliveryLogRows: bAttempts, receiverProcessedCount: bProcessed },
    "DUPLICATE: both attempts genuinely reached the receiver - the naive receiver applied the business effect twice",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "at-least-once scenario failed");
    process.exit(1);
  });
}
