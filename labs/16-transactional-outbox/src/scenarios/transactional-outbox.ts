import "dotenv/config";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import {
  countOrdersByCustomerName,
  findOrderWithOutboxEventByCustomerName,
} from "./query-utils.js";

// Deliberately NOT importing ./broker.ts here. That is not a style choice -
// it is the point of this file. The transactional-outbox write path must
// never call the broker synchronously; publishing is a separate, later
// concern (src/scripts/drain-outbox.ts, and for real in Lab 17). Grep this
// file for "publishToBroker" and you will not find it.

const log = createLogger("lab16:scenario:transactional-outbox");

export interface TransactionalOutboxOptions {
  customerName: string;
  amountCents: number;
  /** Forces the second INSERT (the outbox event) to violate
   * `outbox_events_event_type_valid` by using an event type that is not in
   * the allowed list - the same failure-injection shape as Lab 05's
   * "insufficient funds" CHECK-violation test, but for the outbox row
   * instead of the business row. */
  injectOutboxInsertFailure: boolean;
}

export type TransactionalOutboxResult =
  | { committed: true; orderId: number; outboxEventId: number }
  | { committed: false; reason: string };

/**
 * THE FIX: BEGIN; INSERT order; INSERT outbox_event; COMMIT.
 *
 * Both inserts happen on the same connection, inside the same transaction.
 * Postgres either makes both of them durable together at COMMIT, or (if
 * anything fails first) ROLLBACK undoes both - the order row and the outbox
 * event row can never exist independently of each other. This does not make
 * publishing reliable by itself (see README.md "Why the fix works" and
 * "Tradeoffs") - it only guarantees that "an order was created" and "an
 * OrderCreated event still needs to be published" are recorded as one
 * atomic fact, so `outbox_events` becomes a trustworthy, queryable source of
 * truth for what needs to be published, independent of whether publishing
 * has happened yet.
 */
export async function performTransactionalOrderCreation(
  pool: Pool,
  opts: TransactionalOutboxOptions,
): Promise<TransactionalOutboxResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const orderResult = await client.query<{ id: number }>(
      `INSERT INTO orders (customer_name, amount_cents) VALUES ($1, $2) RETURNING id`,
      [opts.customerName, opts.amountCents],
    );
    const orderId = orderResult.rows[0]!.id;

    const eventType = opts.injectOutboxInsertFailure ? "OrderCreatedTypoBug" : "OrderCreated";
    const outboxResult = await client.query<{ id: number }>(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('order', $1, $2, $3::jsonb)
       RETURNING id`,
      [orderId, eventType, JSON.stringify({ orderId, amountCents: opts.amountCents })],
    );
    const outboxEventId = outboxResult.rows[0]!.id;

    await client.query("COMMIT");
    return { committed: true, orderId, outboxEventId };
  } catch (error) {
    await client.query("ROLLBACK");
    const reason = error instanceof Error ? error.message : String(error);
    return { committed: false, reason };
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  log.info("--- 1. transactional outbox, happy path ---");
  const happyCustomerName = `Outbox Happy - ${randomUUID()}`;
  const happyResult = await performTransactionalOrderCreation(pool, {
    customerName: happyCustomerName,
    amountCents: 3_200,
    injectOutboxInsertFailure: false,
  });
  const happyJoin = await findOrderWithOutboxEventByCustomerName(pool, happyCustomerName);
  log.info(
    { ...happyResult, joinedRows: happyJoin },
    "COMMITTED: exactly one orders row and one outbox_events row, atomically, visible in one join",
  );

  log.info("--- 2. transactional outbox, outbox INSERT forced to fail ---");
  const failCustomerName = `Outbox Rollback - ${randomUUID()}`;
  const failResult = await performTransactionalOrderCreation(pool, {
    customerName: failCustomerName,
    amountCents: 3_200,
    injectOutboxInsertFailure: true,
  });
  const orderCountAfterFail = await countOrdersByCustomerName(pool, failCustomerName);
  log.warn(
    { ...failResult, orderRowsInDb: orderCountAfterFail },
    orderCountAfterFail === 0
      ? "ROLLED BACK: neither the order row nor the outbox event row exists - the failed outbox " +
          "INSERT rolled back the order INSERT too, even though the order INSERT itself succeeded"
      : "unexpected: an order row survived a rolled-back transaction",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "transactional-outbox scenario failed");
    process.exit(1);
  });
}
