import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { sendOnce } from "../delivery/sender.js";
import { naiveProcessMessage } from "../delivery/receiver.js";
import {
  countDeliveryLogRows,
  getReceiverProcessedCount,
  insertNotification,
  recordDeliveryAttempt,
  setNotificationStatus,
} from "./query-utils.js";

const log = createLogger("lab19:scenario:at-most-once");

/**
 * AT-MOST-ONCE: send exactly one time, no retry, no matter what the network
 * does. This trades "no duplicates, ever" for "no delivery guarantee at
 * all" - a message the network drops is gone forever, and nothing in this
 * function (or anywhere else) will ever try again.
 *
 * Runs two cases side by side so the contrast is a single log read:
 *   1. the message is genuinely dropped in transit -> the receiver never
 *      sees it, delivery_log records the loss, receiver_processed_count
 *      stays 0.
 *   2. the message is never dropped -> delivered exactly once, cleanly.
 */
export async function runAtMostOnceLost(pool: Pool, recipient: string): Promise<{ messageId: number }> {
  const message = await insertNotification(pool, {
    recipient,
    body: "Your order has shipped.",
    scenario: "at_most_once_lost",
  });

  const attempt = await sendOnce({
    networkOutcome: "message_lost",
    deliverToReceiver: () => naiveProcessMessage(pool, message.id),
  });
  await recordDeliveryAttempt(pool, message.id, attempt);
  await setNotificationStatus(pool, message.id, "undelivered");

  return { messageId: message.id };
}

export async function runAtMostOnceClean(pool: Pool, recipient: string): Promise<{ messageId: number }> {
  const message = await insertNotification(pool, {
    recipient,
    body: "Your order has shipped.",
    scenario: "at_most_once_clean",
  });

  const attempt = await sendOnce({
    networkOutcome: "success",
    deliverToReceiver: () => naiveProcessMessage(pool, message.id),
  });
  await recordDeliveryAttempt(pool, message.id, attempt);
  await setNotificationStatus(pool, message.id, "delivered");

  return { messageId: message.id };
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const marker = Date.now();

  log.info("--- 1. at-most-once, message dropped in transit ---");
  const lost = await runAtMostOnceLost(pool, `lost-${marker}@example.com`);
  const lostAttempts = await countDeliveryLogRows(pool, lost.messageId);
  const lostProcessed = await getReceiverProcessedCount(pool, lost.messageId);
  log.warn(
    { messageId: lost.messageId, deliveryLogRows: lostAttempts, receiverProcessedCount: lostProcessed },
    "LOST FOREVER: no retry ever happens under at-most-once - the receiver never saw this message",
  );

  log.info("--- 2. at-most-once, message never dropped ---");
  const clean = await runAtMostOnceClean(pool, `clean-${marker}@example.com`);
  const cleanAttempts = await countDeliveryLogRows(pool, clean.messageId);
  const cleanProcessed = await getReceiverProcessedCount(pool, clean.messageId);
  log.info(
    { messageId: clean.messageId, deliveryLogRows: cleanAttempts, receiverProcessedCount: cleanProcessed },
    "delivered exactly once, cleanly - the happy path at-most-once is usually pitched as",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "at-most-once scenario failed");
    process.exit(1);
  });
}
