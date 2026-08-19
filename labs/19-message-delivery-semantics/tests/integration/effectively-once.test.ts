import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { runEffectivelyOnce } from "../../src/scenarios/effectively-once.js";
import { runAckLoss } from "../../src/scenarios/at-least-once.js";
import {
  countDeliveryLogRows,
  countDeliveryLogRowsByOutcome,
  countProcessedMessageIdRows,
  getReceiverProcessedCount,
} from "../../src/scenarios/query-utils.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

describe("effectively-once delivery", () => {
  it("under the identical ack-loss interleaving, delivery_log still shows 2 transport-level attempts, but the idempotent receiver's business effect reflects exactly one application", async () => {
    const marker = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { messageId } = await runEffectivelyOnce(pool, `effonce-${marker}@example.com`);

    // THE DUPLICATE DELIVERY IS NOT ELIMINATED: transport-level, this is
    // byte-for-byte the same shape as at-least-once.ts's ack-loss case -
    // same network script, same retry mechanism, 2 real attempts.
    const totalAttempts = await countDeliveryLogRows(pool, messageId);
    expect(totalAttempts).toBe(2);
    const ackLostAttempts = await countDeliveryLogRowsByOutcome(pool, messageId, "delivered_ack_lost");
    const ackedAttempts = await countDeliveryLogRowsByOutcome(pool, messageId, "delivered_acked");
    expect(ackLostAttempts).toBe(1);
    expect(ackedAttempts).toBe(1);

    // ITS CONSEQUENCE IS ELIMINATED: the idempotent receiver only claimed
    // this message id once in processed_message_ids...
    const claimedRows = await countProcessedMessageIdRows(pool, messageId);
    expect(claimedRows).toBe(1);

    // ...so the business-visible effect happened exactly once, not twice -
    // this is "effectively once," proven directly against the same
    // ack-loss interleaving that produced a real duplicate for the naive
    // receiver in at-least-once.test.ts.
    const processedCount = await getReceiverProcessedCount(pool, messageId);
    expect(processedCount).toBe(1);
  });

  it("contrast: the naive at-least-once receiver run against the SAME ack-loss script produces exactly 2 - proving the difference is the receiver, not the transport", async () => {
    const marker = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const naive = await runAckLoss(pool, `contrast-naive-${marker}@example.com`);
    const idempotent = await runEffectivelyOnce(pool, `contrast-idempotent-${marker}@example.com`);

    // Identical transport-level shape for both.
    expect(await countDeliveryLogRows(pool, naive.messageId)).toBe(2);
    expect(await countDeliveryLogRows(pool, idempotent.messageId)).toBe(2);

    // Different business-visible outcome, solely because of the receiver.
    expect(await getReceiverProcessedCount(pool, naive.messageId)).toBe(2);
    expect(await getReceiverProcessedCount(pool, idempotent.messageId)).toBe(1);
  });
});
