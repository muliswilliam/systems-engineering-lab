import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { sendWithRetry, type SendWithRetryResult } from "../delivery/sender.js";
import { idempotentProcessMessage } from "../delivery/receiver.js";
import {
  countDeliveryLogRows,
  getReceiverProcessedCount,
  insertNotification,
  recordDeliveryAttempt,
  setNotificationStatus,
} from "./query-utils.js";

const log = createLogger("lab19:scenario:effectively-once");

const RETRY = { maxAttempts: 5, backoffMs: (attempt: number) => attempt * 20 };

/**
 * EFFECTIVELY-ONCE = the IDENTICAL at-least-once retry/ack-loss mechanism
 * from at-least-once.ts (same `sendWithRetry`, same network script:
 * `["ack_lost", "success"]`) + an idempotent receiver.
 *
 * This is the precise point this lab exists to make: "effectively once" is
 * not a different, stronger transport. The transport still genuinely
 * delivers the message twice - delivery_log still shows 2 rows below,
 * exactly like at-least-once.ts's ack-loss case. What changes is that the
 * receiver now checks `processed_message_ids` before applying the business
 * effect, so the SECOND genuine delivery finds the message id already
 * claimed and skips the effect. The duplicate delivery is not eliminated;
 * its consequence is.
 */
export async function runEffectivelyOnce(pool: Pool, recipient: string): Promise<{ messageId: number }> {
  const message = await insertNotification(pool, {
    recipient,
    body: "Your invoice is ready.",
    scenario: "effectively_once_ack_loss",
  });

  const result: SendWithRetryResult = await sendWithRetry({
    script: { outcomes: ["ack_lost", "success"] },
    retry: RETRY,
    deliverToReceiver: async (attemptNumber) => {
      const { applied } = await idempotentProcessMessage(pool, message.id);
      log.info({ messageId: message.id, attemptNumber, applied }, "receiver invoked");
    },
    onAttempt: (attempt) => recordDeliveryAttempt(pool, message.id, attempt),
  });
  await setNotificationStatus(pool, message.id, result.acked ? "delivered" : "undelivered");

  return { messageId: message.id };
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const marker = Date.now();

  log.info("--- effectively-once: identical ack-loss interleaving as at-least-once.ts's case (b) ---");
  const result = await runEffectivelyOnce(pool, `effonce-${marker}@example.com`);
  const attempts = await countDeliveryLogRows(pool, result.messageId);
  const processed = await getReceiverProcessedCount(pool, result.messageId);

  log.info(
    { messageId: result.messageId, deliveryLogRows: attempts, receiverProcessedCount: processed },
    attempts === 2 && processed === 1
      ? "FIXED: transport still shows 2 delivery attempts, but the business-visible effect happened exactly once"
      : "unexpected: counts do not match the documented effectively-once guarantee",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "effectively-once scenario failed");
    process.exit(1);
  });
}
