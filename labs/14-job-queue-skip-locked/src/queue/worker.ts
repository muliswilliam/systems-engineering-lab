import type { Pool } from "pg";
import { claimJob, completeJob, failJob } from "./claim.js";
import type { JobRow } from "./types.js";

/** Minimal shape of the Pino logger returned by @labs/logging's
 * createLogger - avoids taking a direct dependency on pino's types just for
 * this one optional parameter. */
export interface WorkerLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface WorkerRunResult {
  workerId: string;
  claimedJobIds: number[];
  completedJobIds: number[];
  failedAttemptJobIds: number[];
}

export interface RunWorkerOptions {
  leaseMs: number;
  process: (job: JobRow) => Promise<void>;
  log?: WorkerLogger;
}

/**
 * One worker's full lifecycle: claim a job, process it, mark it
 * completed/failed, repeat until the queue has nothing left to claim
 * (claimJob returns null). This is the loop every scenario (1/5/50 workers)
 * and every concurrency test runs concurrently, one call per worker.
 */
export async function runWorkerUntilEmpty(
  pool: Pool,
  workerId: string,
  opts: RunWorkerOptions,
): Promise<WorkerRunResult> {
  const result: WorkerRunResult = {
    workerId,
    claimedJobIds: [],
    completedJobIds: [],
    failedAttemptJobIds: [],
  };

  for (;;) {
    const claim = await claimJob(pool, workerId, opts.leaseMs);
    if (!claim) {
      break;
    }
    result.claimedJobIds.push(claim.job.id);
    opts.log?.info(
      { workerId, jobId: claim.job.id, jobType: claim.job.jobType, attempt: claim.job.attempts, reclaimed: claim.reclaimed },
      "claimed job",
    );

    try {
      await opts.process(claim.job);
      await completeJob(pool, claim.job.id, claim.attemptId);
      result.completedJobIds.push(claim.job.id);
      opts.log?.info({ workerId, jobId: claim.job.id }, "completed job");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failResult = await failJob(pool, claim.job.id, claim.attemptId, message);
      result.failedAttemptJobIds.push(claim.job.id);
      opts.log?.warn(
        { workerId, jobId: claim.job.id, attempt: failResult.attempts, maxAttempts: failResult.maxAttempts, terminal: failResult.terminal, err: error },
        failResult.terminal ? "job permanently failed (max attempts reached)" : "attempt failed, job returned to pending for retry",
      );
    }
  }

  return result;
}
