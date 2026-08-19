import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { runAtMostOnceClean, runAtMostOnceLost } from "../../src/scenarios/at-most-once.js";
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

/**
 * Per CLAUDE.md's "show failure before the fix" and SPEC.md section 11: the
 * real, distinct fact this lab claims for at-most-once is proven here as an
 * assertion, not narrated in the README.
 */
describe("at-most-once delivery", () => {
  it("a dropped message is never redelivered and the receiver never processes it", async () => {
    const marker = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { messageId } = await runAtMostOnceLost(pool, `lost-${marker}@example.com`);

    // Exactly one attempt was ever made - no retry happened, because
    // at-most-once never retries regardless of outcome.
    const totalAttempts = await countDeliveryLogRows(pool, messageId);
    expect(totalAttempts).toBe(1);

    // That one attempt is recorded as lost, and there is no successful
    // attempt anywhere in delivery_log for this message.
    const lostAttempts = await countDeliveryLogRowsByOutcome(pool, messageId, "sent_lost");
    const ackedAttempts = await countDeliveryLogRowsByOutcome(pool, messageId, "delivered_acked");
    expect(lostAttempts).toBe(1);
    expect(ackedAttempts).toBe(0);

    // The receiver's business-visible effect never ran - it never saw the
    // message at all.
    const processedCount = await getReceiverProcessedCount(pool, messageId);
    expect(processedCount).toBe(0);
  });

  it("a message that is never dropped is delivered exactly once, cleanly", async () => {
    const marker = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { messageId } = await runAtMostOnceClean(pool, `clean-${marker}@example.com`);

    const totalAttempts = await countDeliveryLogRows(pool, messageId);
    expect(totalAttempts).toBe(1);

    const ackedAttempts = await countDeliveryLogRowsByOutcome(pool, messageId, "delivered_acked");
    expect(ackedAttempts).toBe(1);

    const processedCount = await getReceiverProcessedCount(pool, messageId);
    expect(processedCount).toBe(1);
  });
});
