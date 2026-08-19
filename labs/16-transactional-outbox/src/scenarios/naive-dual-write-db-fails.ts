import "dotenv/config";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { publishToBroker } from "./broker.js";
import { countOrdersByCustomerName } from "./query-utils.js";

const log = createLogger("lab16:scenario:naive-db-fails");

export interface NaiveDbFailsOptions {
  customerName: string;
  /** A positive amount, so the happy-path broker call and payload look
   * realistic; the actual INSERT below deliberately uses a NEGATIVE amount
   * to trip the `orders_amount_cents_positive` CHECK constraint, standing in
   * for "the DB write failed for some reason after the broker already
   * accepted the publish" (a constraint violation, a deadlock, a lost
   * connection - the specific cause does not matter to this scenario). */
  amountCents: number;
}

export type NaiveDbFailsResult =
  | { brokerPublished: true; orderCommitted: true; orderId: number }
  | { brokerPublished: true; orderCommitted: false; dbErrorCode?: string; dbErrorMessage: string };

/**
 * DUAL WRITE, DIRECTION 2 (the direction people forget): the broker publish
 * succeeds FIRST, and the DB write fails afterward.
 *
 * This is the mirror image of naive-dual-write-broker-fails.ts. Engineers
 * reflexively reach for "what if the broker is down" and build retries
 * around the publish call - but by the time this function calls
 * `publishToBroker`, the broker has already (in this simulation) durably
 * accepted the event. If the order INSERT that follows fails for any reason,
 * the broker believes an `OrderCreated` event was sent for an order that
 * does not, and never will, exist in this database. Any downstream consumer
 * of that event now has a phantom order to reconcile - see README.md "Break
 * it".
 */
export async function performNaiveBrokerPublishThenOrder(
  pool: Pool,
  opts: NaiveDbFailsOptions,
): Promise<NaiveDbFailsResult> {
  await publishToBroker(
    {
      eventType: "OrderCreated",
      aggregateType: "order",
      // No order id exists yet - a real system would generate one client-side
      // (e.g. a UUID) up front for this exact reason; kept as 0 here since
      // this scenario's whole point is that no order row backs this event.
      aggregateId: 0,
      payload: { customerName: opts.customerName, amountCents: opts.amountCents },
    },
    { failureMode: "never" },
  );

  try {
    // Deliberately negative: the `orders_amount_cents_positive` CHECK
    // constraint rejects this INSERT outright, standing in for "the DB write
    // failed after the broker already accepted the publish."
    const insertResult = await pool.query<{ id: number }>(
      `INSERT INTO orders (customer_name, amount_cents) VALUES ($1, $2) RETURNING id`,
      [opts.customerName, -Math.abs(opts.amountCents)],
    );
    return { brokerPublished: true, orderCommitted: true, orderId: insertResult.rows[0]!.id };
  } catch (error) {
    const pgError = error as { code?: string; message?: string };
    return {
      brokerPublished: true,
      orderCommitted: false,
      dbErrorCode: pgError.code,
      dbErrorMessage: pgError.message ?? String(error),
    };
  }
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const customerName = `Naive DB Fails - ${randomUUID()}`;
  const amountCents = 7_500;

  log.info("--- naive dual write: broker publish succeeds, DB write fails ---");
  const result = await performNaiveBrokerPublishThenOrder(pool, { customerName, amountCents });

  const orderCount = await countOrdersByCustomerName(pool, customerName);

  log.warn(
    {
      brokerPublished: result.brokerPublished,
      orderCommitted: result.orderCommitted,
      dbErrorCode: !result.orderCommitted ? result.dbErrorCode : undefined,
      dbErrorMessage: !result.orderCommitted ? result.dbErrorMessage : undefined,
      orderRowsInDb: orderCount,
    },
    "CORRUPTED: the broker believes an OrderCreated event was sent, but no order row for it ever " +
      "existed - a downstream consumer now has a phantom order to reconcile",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "naive-dual-write-db-fails scenario failed");
    process.exit(1);
  });
}
