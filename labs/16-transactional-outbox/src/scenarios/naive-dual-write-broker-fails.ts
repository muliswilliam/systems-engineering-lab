import "dotenv/config";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { BrokerPublishError, publishToBroker } from "./broker.js";
import { countOrdersByCustomerName, countOutboxEventsForOrder } from "./query-utils.js";

const log = createLogger("lab16:scenario:naive-broker-fails");

export interface NaiveBrokerFailsOptions {
  customerName: string;
  amountCents: number;
}

export interface NaiveBrokerFailsResult {
  orderId: number;
  orderCommitted: true;
  brokerPublished: boolean;
  brokerError?: string;
}

/**
 * DUAL WRITE, DIRECTION 1: the DB write succeeds, the broker publish fails.
 *
 * No outbox table is involved at all here - this is the naive "just write
 * the row, then tell the broker" shape. The order INSERT is its own
 * complete, already-committed statement (Postgres autocommit, same as
 * Lab 05's naive transfer). By the time `publishToBroker` is even called,
 * the order is durable and visible to every other connection - there is no
 * way to "undo" it just because the very next step fails.
 *
 * If the broker call throws (simulating a down broker, a network partition,
 * a timeout - anything), there is now a real order in the database with
 * NOTHING durably recorded anywhere that says "an OrderCreated event still
 * needs to be published for this order." A downstream system (billing,
 * fulfillment, analytics) that only learns about orders via that event will
 * never find out this order exists, and no queryable state in this database
 * can recover that fact - see README.md "Break it".
 */
export async function performNaiveOrderThenBrokerPublish(
  pool: Pool,
  opts: NaiveBrokerFailsOptions,
): Promise<NaiveBrokerFailsResult> {
  const insertResult = await pool.query<{ id: number }>(
    `INSERT INTO orders (customer_name, amount_cents) VALUES ($1, $2) RETURNING id`,
    [opts.customerName, opts.amountCents],
  );
  const orderId = insertResult.rows[0]!.id;

  try {
    await publishToBroker(
      {
        eventType: "OrderCreated",
        aggregateType: "order",
        aggregateId: orderId,
        payload: { orderId, amountCents: opts.amountCents },
      },
      { failureMode: "always" },
    );
    return { orderId, orderCommitted: true, brokerPublished: true };
  } catch (error) {
    const brokerError = error instanceof BrokerPublishError ? error.message : String(error);
    return { orderId, orderCommitted: true, brokerPublished: false, brokerError };
  }
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const customerName = `Naive Broker Fails - ${randomUUID()}`;
  const amountCents = 4_999;

  log.info("--- naive dual write: DB commits, broker publish fails ---");
  const result = await performNaiveOrderThenBrokerPublish(pool, { customerName, amountCents });

  const orderCount = await countOrdersByCustomerName(pool, customerName);
  const outboxCount = await countOutboxEventsForOrder(pool, result.orderId);

  log.warn(
    {
      orderId: result.orderId,
      orderExistsInDb: orderCount === 1,
      brokerPublished: result.brokerPublished,
      brokerError: result.brokerError,
      outboxEventsRecorded: outboxCount,
    },
    "CORRUPTED: the order is durable, but nothing durable says this order still needs to be published - " +
      "no reconciliation query can recover that fact from this database alone",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "naive-dual-write-broker-fails scenario failed");
    process.exit(1);
  });
}
