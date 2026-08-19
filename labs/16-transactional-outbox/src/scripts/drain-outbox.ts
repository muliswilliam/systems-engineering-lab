import "dotenv/config";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { publishToBroker, type BrokerEvent } from "../scenarios/broker.js";

const log = createLogger("lab16:drain-outbox");

export interface OutboxEventRow {
  id: number;
  aggregateType: string;
  aggregateId: number;
  eventType: string;
  payload: unknown;
}

export interface DrainOutboxOptions {
  limit?: number;
  /** Injectable for tests, so a test can count publish calls (and assert a
   * second drain calls it zero more times) without mocking a module. */
  publish?: (event: BrokerEvent) => Promise<void>;
}

export interface DrainOutboxResult {
  attempted: number;
  publishedIds: number[];
  failedIds: number[];
}

/**
 * A MINIMAL, ONE-SHOT preview of what Lab 17 builds into a real worker - NOT
 * a full publisher. This function:
 *
 *   1. reads outbox_events WHERE published_at IS NULL;
 *   2. calls publishToBroker for each one;
 *   3. sets published_at on success.
 *
 * It deliberately does NOT use `FOR UPDATE SKIP LOCKED`, does not run
 * multiple workers concurrently, and does not handle a crash between step 2
 * and step 3 (which would re-publish the same event on the next drain - the
 * exact "at least once, so consumers must be idempotent" problem Lab 18
 * covers). Running two of these concurrently against the same table would
 * double-publish unpublished rows, because nothing here claims a row before
 * working on it. See README.md "Tradeoffs" and Lab 17/18's specs for what a
 * production-grade version needs.
 */
export async function drainOutbox(pool: Pool, options: DrainOutboxOptions = {}): Promise<DrainOutboxResult> {
  const { limit = 100 } = options;
  const publish =
    options.publish ??
    ((event: BrokerEvent) => publishToBroker(event, { failureMode: "never" }));

  const result = await pool.query<{
    id: number;
    aggregate_type: string;
    aggregate_id: number;
    event_type: string;
    payload: unknown;
  }>(
    `SELECT id, aggregate_type, aggregate_id, event_type, payload
     FROM outbox_events
     WHERE published_at IS NULL
     ORDER BY created_at
     LIMIT $1`,
    [limit],
  );

  const publishedIds: number[] = [];
  const failedIds: number[] = [];

  for (const row of result.rows) {
    try {
      await publish({
        eventType: row.event_type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
      });
      await pool.query("UPDATE outbox_events SET published_at = now() WHERE id = $1", [row.id]);
      publishedIds.push(row.id);
    } catch (error) {
      failedIds.push(row.id);
      log.error({ err: error, outboxEventId: row.id }, "failed to publish outbox event");
    }
  }

  return { attempted: result.rows.length, publishedIds, failedIds };
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  log.info("--- draining outbox_events WHERE published_at IS NULL ---");
  const result = await drainOutbox(pool);
  log.info(result, "drain complete");

  log.info("--- draining again immediately - should publish 0 events ---");
  const secondResult = await drainOutbox(pool);
  log.info(
    secondResult,
    secondResult.attempted === 0
      ? "confirmed: no already-published event was re-published"
      : "unexpected: a second immediate drain found events to publish",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "drain-outbox failed");
    process.exit(1);
  });
}
