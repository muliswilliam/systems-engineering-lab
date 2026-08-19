import "dotenv/config";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createLogger } from "@labs/logging";
import { measureSingleWrite, startWriteProber, summarizeLatencies } from "./write-prober.js";

const log = createLogger("lab30:scenario:naive");

export interface NaiveGiantUpdateResult {
  durationMs: number;
  rowsUpdated: number;
}

/**
 * THE NAIVE APPROACH: one single `UPDATE` statement, one implicit
 * transaction, touching every row that still needs backfilling. This is
 * exactly what it looks like to write "just backfill the column" without
 * thinking about scale - it is correct (every row ends up with the right
 * value) and, on a small table, fast. On a genuinely large table it becomes
 * dangerous for two independent reasons, both real and both measured by this
 * scenario:
 *
 * 1. Postgres acquires a row-level lock on every row this UPDATE touches,
 *    and - because it's all one transaction - holds every one of those locks
 *    until the whole statement commits, not just while each individual row
 *    is being processed. An ordinary, completely unrelated write against ANY
 *    row this UPDATE has already reached is blocked for the REST of this
 *    transaction's lifetime, however long that turns out to be.
 * 2. Because it is one long-running transaction, Postgres cannot vacuum away
 *    any dead tuple this transaction's own snapshot could still see,
 *    anywhere in the database, for the transaction's entire duration - not
 *    just in this table. A backfill that runs for minutes therefore also
 *    grows bloat system-wide for those same minutes. See README "Break it"
 *    for the full explanation - this lab does not build a separate bloat
 *    demo (Lab 31 covers VACUUM/bloat in depth).
 */
export async function runNaiveGiantUpdate(connectionString: string): Promise<NaiveGiantUpdateResult> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const start = performance.now();
    const result = await client.query(
      "UPDATE orders SET loyalty_points = floor(amount_cents / 100.0) WHERE loyalty_points IS NULL",
    );
    return { durationMs: performance.now() - start, rowsUpdated: result.rowCount ?? 0 };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const connectionString = process.env.DATABASE_URL;

  const infoClient = new Client({ connectionString });
  await infoClient.connect();
  const totals = await infoClient.query<{ total: string; pending: string; min_id: string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE loyalty_points IS NULL) AS pending,
            min(id) AS min_id
     FROM orders`,
  );
  await infoClient.end();

  const row = totals.rows[0];
  if (!row || row.min_id === null) {
    throw new Error("orders table is empty - run `pnpm seed` first");
  }
  const targetOrderId = Number(row.min_id);

  log.info(
    { totalRows: Number(row.total), pendingRows: Number(row.pending), targetOrderId },
    "--- naive scenario: one giant UPDATE against the whole pending cohort ---",
  );

  log.info({ targetOrderId }, "baseline: measuring an ordinary write's latency with NO contention");
  const baselineLatencyMs = await measureSingleWrite(connectionString, targetOrderId);
  log.info({ baselineLatencyMs: Number(baselineLatencyMs.toFixed(2)) }, "baseline ordinary write completed");

  log.info("issuing the naive giant UPDATE (not yet awaited) ...");
  const naivePromise = runNaiveGiantUpdate(connectionString);

  // Give the giant UPDATE's scan a moment to actually reach and lock
  // targetOrderId (the lowest id in the table) before we start probing it -
  // otherwise this script could win a trivial race against its own scan.
  await new Promise((resolve) => setTimeout(resolve, 150));

  log.info(
    { targetOrderId },
    "starting ordinary-write probes against the SAME row while the giant UPDATE is in flight",
  );
  const prober = startWriteProber(connectionString, targetOrderId, 400);

  const naiveResult = await naivePromise;
  const probedSamples = await prober.stop();
  const blockedSummary = summarizeLatencies(probedSamples);

  log.warn(
    {
      naiveDurationMs: Number(naiveResult.durationMs.toFixed(2)),
      rowsUpdated: naiveResult.rowsUpdated,
      baselineLatencyMs: Number(baselineLatencyMs.toFixed(2)),
      ordinaryWriteWhileBlockedMs: blockedSummary,
    },
    "naive giant UPDATE finished - every ordinary write attempted during its execution was blocked until it committed",
  );

  log.warn(
    {
      worstCaseBlockedMs: blockedSummary.maxMs,
      naiveDurationMs: Number(naiveResult.durationMs.toFixed(2)),
      ratio: Number((blockedSummary.maxMs / naiveResult.durationMs).toFixed(3)),
    },
    "the earliest ordinary write attempt was blocked for essentially the FULL duration of the naive UPDATE - this is the incident: any unrelated write touching a row this statement has already locked queues up for the whole backfill, not just for its own row's turn",
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "naive scenario failed");
    process.exit(1);
  });
}
