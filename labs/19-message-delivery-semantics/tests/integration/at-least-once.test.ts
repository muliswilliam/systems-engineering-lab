import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { runAckLoss, runMessageLossThenSuccess } from "../../src/scenarios/at-least-once.js";
import {
  countDeliveryLogRows,
  countDeliveryLogRowsByOutcome,
  getReceiverProcessedCount,
} from "../../src/scenarios/query-utils.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await pool.end();
});

describe("at-least-once delivery", () => {
  it("message-loss case: exactly 2 delivery attempts occur (1 failed, 1 succeeded) and the receiver processes it exactly once", async () => {
    const marker = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { messageId } = await runMessageLossThenSuccess(pool, `msgloss-${marker}@example.com`);

    const totalAttempts = await countDeliveryLogRows(pool, messageId);
    expect(totalAttempts).toBe(2);

    const lostAttempts = await countDeliveryLogRowsByOutcome(pool, messageId, "sent_lost");
    const ackedAttempts = await countDeliveryLogRowsByOutcome(pool, messageId, "delivered_acked");
    expect(lostAttempts).toBe(1);
    expect(ackedAttempts).toBe(1);

    // The lost attempt never reached the receiver, so only the successful
    // retry actually triggered the business effect.
    const processedCount = await getReceiverProcessedCount(pool, messageId);
    expect(processedCount).toBe(1);
  });

  it("ack-loss case: exactly 2 delivery attempts occur and BOTH succeed at the transport level, and the naive receiver processes it twice - a real duplicate", async () => {
    const marker = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { messageId } = await runAckLoss(pool, `ackloss-${marker}@example.com`);

    const totalAttempts = await countDeliveryLogRows(pool, messageId);
    expect(totalAttempts).toBe(2);

    // Neither attempt was "sent_lost" - the message itself reached the
    // receiver both times. The first attempt's ack was lost; the second
    // attempt's ack got through.
    const lostAttempts = await countDeliveryLogRowsByOutcome(pool, messageId, "sent_lost");
    const ackLostAttempts = await countDeliveryLogRowsByOutcome(pool, messageId, "delivered_ack_lost");
    const ackedAttempts = await countDeliveryLogRowsByOutcome(pool, messageId, "delivered_acked");
    expect(lostAttempts).toBe(0);
    expect(ackLostAttempts).toBe(1);
    expect(ackedAttempts).toBe(1);

    // The naive receiver has no memory of attempt 1, so it genuinely applied
    // the business effect twice. This is the real duplicate this lab exists
    // to make observable, not merely asserted in prose.
    const processedCount = await getReceiverProcessedCount(pool, messageId);
    expect(processedCount).toBe(2);
  });
});
