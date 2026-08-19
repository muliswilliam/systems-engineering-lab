import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { explainKeysetPage, getCursorAtOffset, getTotalRowCount, median } from "./pagination-lib.js";

const log = createLogger("lab34:scenario:keyset");

const PAGE_SIZE = 20;
const ITERATIONS_PER_DEPTH = 5;

function parseArgs(): { depths: number[] } {
  const args = process.argv.slice(2);
  const depthsArg = args.find((a) => a.startsWith("--depths="))?.split("=")[1];
  const depths = depthsArg ? depthsArg.split(",").map(Number) : [0, 2_000, 20_000, 100_000, 400_000];
  return { depths };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  const totalRows = await getTotalRowCount(pool);
  const { depths: requestedDepths } = parseArgs();
  const depths = requestedDepths.filter((d) => d < totalRows);

  log.info(
    { totalRows, pageSize: PAGE_SIZE, depths, iterationsPerDepth: ITERATIONS_PER_DEPTH },
    "--- KEYSET PAGINATION: measuring REAL EXPLAIN ANALYZE execution time at the SAME depths as the OFFSET scenario ---",
  );
  log.info(
    "NOTE: getCursorAtOffset() below uses OFFSET only to SYNTHESIZE a valid cursor for this benchmark, so depths line up 1:1 with scenario:offset. That OFFSET lookup is NOT part of the measured time. A real client never does this - it always already holds the cursor from the previous page it fetched. See README Tradeoffs.",
  );

  const results: {
    offset: number;
    page: number;
    medianExecutionMs: number;
    planningMs: number;
    topNodeType: string;
    sharedBuffersTouched: number;
  }[] = [];

  for (const offset of depths) {
    const cursor = offset === 0 ? null : await getCursorAtOffset(pool, offset - 1);

    let lastPlanningMs = 0;
    let lastNodeType = "";
    let lastBuffers = 0;

    const medianExecutionMs = await median(ITERATIONS_PER_DEPTH, async () => {
      const result = await explainKeysetPage(pool, cursor, PAGE_SIZE);
      lastPlanningMs = result.planningTimeMs;
      lastNodeType = result.topNodeType;
      lastBuffers = result.buffers.sharedHit + result.buffers.sharedRead;
      return result.executionTimeMs;
    });

    const row = {
      offset,
      page: Math.floor(offset / PAGE_SIZE) + 1,
      medianExecutionMs: Number(medianExecutionMs.toFixed(3)),
      planningMs: Number(lastPlanningMs.toFixed(3)),
      topNodeType: lastNodeType,
      sharedBuffersTouched: lastBuffers,
    };
    results.push(row);
    log.warn(
      row,
      `keyset page starting after position ${offset} - real median EXPLAIN ANALYZE execution time over ${ITERATIONS_PER_DEPTH} runs`,
    );
  }

  const executionTimes = results.map((r) => r.medianExecutionMs);
  const min = Math.min(...executionTimes);
  const max = Math.max(...executionTimes);

  log.warn(
    {
      summary: results.map((r) => ({ offset: r.offset, medianExecutionMs: r.medianExecutionMs, sharedBuffersTouched: r.sharedBuffersTouched })),
      minMs: min,
      maxMs: max,
      maxToMinRatio: Number((max / Math.max(min, 0.001)).toFixed(2)),
    },
    "FLAT SUMMARY: unlike OFFSET, keyset execution time and shared buffers touched stay roughly constant regardless of depth - the (created_at, id) index lets Postgres seek directly to the cursor's position via an Index Scan, with no preceding rows to walk and discard",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "keyset pagination scenario failed");
    process.exit(1);
  });
}
