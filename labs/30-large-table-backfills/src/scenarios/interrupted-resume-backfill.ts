import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { backfillLoyaltyPoints } from "./batched-resumable-backfill.js";

const log = createLogger("lab30:scenario:interrupted-resume");

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface Counts {
  total: number;
  backfilled: number;
  pending: number;
}

async function readCounts(connectionString: string): Promise<Counts> {
  const pool = createPool({ connectionString });
  try {
    const result = await pool.query<{ total: string; backfilled: string }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE loyalty_points IS NOT NULL) AS backfilled FROM orders`,
    );
    const row = result.rows[0]!;
    const total = Number(row.total);
    const backfilled = Number(row.backfilled);
    return { total, backfilled, pending: total - backfilled };
  } finally {
    await pool.end();
  }
}

/**
 * GENUINE RESUMABILITY: this does not simulate a crash by throwing in-process
 * - it spawns the batched backfill as a real, separate OS process (exactly
 * `pnpm scenario:batched` would), lets it run for a fixed wall-clock window,
 * and then sends it a real SIGKILL - the same signal an OOM killer, a bad
 * deploy, or `docker kill` would send. Whatever batches had already committed
 * to Postgres before the kill landed are the only state that survives; the
 * killed process gets no chance to run any cleanup code, flush anything, or
 * even log that it was killed.
 *
 * Then, in a completely fresh call to `backfillLoyaltyPoints`, this script
 * proves the invariant that matters: resuming does not re-process any
 * already-committed row and does not skip any row - it just continues from
 * `WHERE loyalty_points IS NULL`, and the table ends up 100% backfilled with
 * `firstRunRows + secondRunRows === totalRows`.
 */
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const connectionString = process.env.DATABASE_URL;

  const before = await readCounts(connectionString);
  if (before.pending === 0) {
    throw new Error(
      "orders table has 0 pending rows - reseed first (`pnpm seed`) so this demo has real work to interrupt",
    );
  }
  log.info(before, "--- interrupted/resume scenario: starting state ---");

  const killAfterMs = 1_000;
  log.info(
    { killAfterMs },
    "spawning `pnpm scenario:batched` as a REAL child process, will SIGKILL it mid-run",
  );

  // Run `node --import tsx/esm src/scenarios/batched-resumable-backfill.ts`
  // DIRECTLY, rather than `pnpm exec tsx ...` or the `tsx` CLI binary. Both
  // of those interpose their own wrapper process that internally spawns a
  // SEPARATE node process to actually run the script - killing only the
  // wrapper leaves that real process running as an orphan, which silently
  // defeats this entire demonstration (confirmed by hand: the "killed"
  // process kept committing batches in the background). `--import` loads
  // the tsx ESM loader into THIS process, so there is exactly one pid to
  // kill, and SIGKILL to it is immediate and final.
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", "src/scenarios/batched-resumable-backfill.ts", "--batch-size=200", "--sleep-ms=100"],
    { cwd: labRoot, stdio: "inherit", env: process.env },
  );

  const exitInfo = await new Promise<{ killed: boolean; code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, killAfterMs);

      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ killed: signal === "SIGKILL", code, signal });
      });
    },
  );

  log.warn(exitInfo, "child process is dead - it got no chance to log, flush, or clean up anything");

  const afterKill = await readCounts(connectionString);
  log.info(afterKill, "state immediately after the kill - some batches committed, the rest did not run");

  if (afterKill.pending === 0) {
    log.warn(
      "the child process finished the ENTIRE backfill before the kill landed - increase the dataset size " +
        "(pnpm seed --size=medium) or lower killAfterMs to reliably observe a partial state",
    );
  } else if (afterKill.backfilled === 0) {
    log.warn(
      "the child process was killed before even its FIRST batch committed - lower --sleep-ms/--batch-size or " +
        "raise killAfterMs to reliably observe partial progress",
    );
  }

  log.info("--- resuming: calling backfillLoyaltyPoints again, in-process, no maxBatches limit ---");
  const pool = createPool({ connectionString });
  await waitForDatabase(pool);
  const resumeStart = performance.now();
  const resumeResult = await backfillLoyaltyPoints(pool, { batchSize: 500, sleepMs: 0 });
  const resumeDurationMs = performance.now() - resumeStart;
  await pool.end();

  const after = await readCounts(connectionString);

  log.info(
    {
      resumeBatches: resumeResult.batches,
      resumeRowsBackfilled: resumeResult.rowsBackfilled,
      resumeDurationMs: Number(resumeDurationMs.toFixed(0)),
    },
    "resume run complete",
  );

  const firstRunRows = afterKill.backfilled - before.backfilled;
  const invariantHolds =
    after.pending === 0 && firstRunRows + resumeResult.rowsBackfilled === after.total - before.backfilled;

  log.info(
    {
      totalRows: after.total,
      alreadyBackfilledBeforeThisRun: before.backfilled,
      firstRunRowsBeforeKill: firstRunRows,
      secondRunRowsAfterResume: resumeResult.rowsBackfilled,
      finalPending: after.pending,
      invariantHolds,
    },
    invariantHolds
      ? "RESUMABLE, VERIFIED: killed run's rows + resumed run's rows account for exactly the remaining work, zero double-processed, zero skipped, zero rows left NULL"
      : "invariant check failed - see counts above",
  );

  if (!invariantHolds) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  log.error({ err: error }, "interrupted/resume scenario failed");
  process.exit(1);
});
