import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { explainOffsetPage, getTotalRowCount, median } from "./pagination-lib.js";

const log = createLogger("lab34:scenario:offset");

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
    "--- NAIVE OFFSET PAGINATION: measuring REAL EXPLAIN ANALYZE execution time as OFFSET grows ---",
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
    let lastPlanningMs = 0;
    let lastNodeType = "";
    let lastBuffers = 0;

    const medianExecutionMs = await median(ITERATIONS_PER_DEPTH, async () => {
      const result = await explainOffsetPage(pool, offset, PAGE_SIZE);
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
    log.warn(row, `OFFSET ${offset} (page ${row.page}) - real median EXPLAIN ANALYZE execution time over ${ITERATIONS_PER_DEPTH} runs`);
  }

  const first = results[0]!;
  const last = results[results.length - 1]!;
  const slowdownRatio = last.medianExecutionMs / Math.max(first.medianExecutionMs, 0.001);

  log.warn(
    {
      summary: results.map((r) => ({ offset: r.offset, medianExecutionMs: r.medianExecutionMs, sharedBuffersTouched: r.sharedBuffersTouched })),
      slowdownRatio: Number(slowdownRatio.toFixed(1)),
    },
    "DEGRADATION SUMMARY: execution time and shared buffers touched both grow with OFFSET, even though every query uses the SAME (created_at, id) index - the index only tells Postgres the ORDER of rows, not how to skip directly to the Nth one, so Postgres must still walk and discard every row before the offset",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "offset pagination scenario failed");
    process.exit(1);
  });
}
