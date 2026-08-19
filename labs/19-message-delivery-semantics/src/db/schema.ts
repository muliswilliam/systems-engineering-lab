import { sql } from "drizzle-orm";
import { pgTable, bigint, uuid, text, integer, timestamp, check } from "drizzle-orm/pg-core";

/**
 * A fresh, self-contained "notification platform" domain - not one of
 * SPEC.md 8.2's five named domains (payroll/ticketing/commerce/ledger/
 * background-processing). This lab's subject is delivery semantics between
 * an independent sender and receiver, which needs the smallest possible
 * "a message needs to reach someone" entity, not a rich relational model
 * (same rationale as Lab 06's `counters`, Lab 11's `documents`, and Lab 15's
 * `payments` - see those labs' README "Architecture" sections). Defined only
 * in this lab's own schema, per the independent-labs principle; no import
 * from Labs 16-18 even though they are the conceptually closest
 * predecessors (transactional outbox / SKIP LOCKED publishers / idempotent
 * consumers).
 *
 * `receiver_processed_count` is the business-visible side effect this lab
 * measures directly: every scenario's receiver, naive or idempotent,
 * increments this counter exactly once per time it genuinely applies the
 * business effect for this message. At-most-once and the message-loss case
 * of at-least-once increment it 0 or 1 times. The naive receiver in the
 * at-least-once ack-loss case increments it twice - a real, queryable,
 * asserted duplicate. The idempotent receiver in effectively-once.ts
 * increments it once even under the identical ack-loss interleaving,
 * because it only increments after successfully claiming the message id in
 * `processed_message_ids` (see src/delivery/receiver.ts).
 */
export const notifications = pgTable(
  "notifications",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    recipient: text("recipient").notNull(),
    body: text("body").notNull(),
    scenario: text("scenario").notNull(),
    status: text("status").notNull().default("pending"),
    receiverProcessedCount: integer("receiver_processed_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "notifications_scenario_valid",
      sql`${table.scenario} in (
        'at_most_once_lost',
        'at_most_once_clean',
        'at_least_once_message_loss',
        'at_least_once_ack_loss',
        'effectively_once_ack_loss'
      )`,
    ),
    check("notifications_status_valid", sql`${table.status} in ('pending', 'delivered', 'undelivered')`),
    check("notifications_receiver_processed_count_non_negative", sql`${table.receiverProcessedCount} >= 0`),
  ],
);

/**
 * One row per delivery ATTEMPT, not per message - this is the table that
 * lets every scenario's README claim be checked with a real `SELECT count(*)`
 * instead of taken on faith. `outcome` records what the simulated network did
 * on that specific attempt:
 *
 *   - `sent_lost`          the message itself never reached the receiver.
 *                          `deliverToReceiver` was never called for this
 *                          attempt.
 *   - `delivered_ack_lost` the receiver genuinely received and processed the
 *                          message, but the acknowledgment back to the
 *                          sender was lost - the sender has no way to tell
 *                          this apart from `sent_lost` and must retry.
 *   - `delivered_acked`    the receiver processed the message and the sender
 *                          received the acknowledgment - the sender stops
 *                          retrying.
 *
 * `delivered_at` is populated for every row regardless of outcome (it is the
 * timestamp of the attempt, not proof of a successful delivery) - see
 * src/delivery/sender.ts for why the column name follows SPEC.md's wording
 * even though a `sent_lost` row did not, in fact, deliver anything.
 */
export const deliveryLog = pgTable(
  "delivery_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    messageId: bigint("message_id", { mode: "number" })
      .notNull()
      .references(() => notifications.id),
    attemptNumber: integer("attempt_number").notNull(),
    outcome: text("outcome").notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("delivery_log_outcome_valid", sql`${table.outcome} in ('sent_lost', 'delivered_ack_lost', 'delivered_acked')`),
    check("delivery_log_attempt_number_positive", sql`${table.attemptNumber} > 0`),
  ],
);

/**
 * The inbox/idempotency table (the same core mechanism Lab 18 would use in
 * full, built fresh here): `message_id` is UNIQUE, so a second attempt to
 * claim the same message id fails the `INSERT ... ON CONFLICT DO NOTHING`
 * (returns zero rows) instead of raising an error. Only
 * `effectively-once.ts`'s receiver writes to this table - the naive
 * receivers used by at-most-once.ts and at-least-once.ts never consult it,
 * which is exactly why they can double-process a message and this receiver
 * cannot.
 */
export const processedMessageIds = pgTable("processed_message_ids", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  messageId: bigint("message_id", { mode: "number" })
    .notNull()
    .unique()
    .references(() => notifications.id),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});
