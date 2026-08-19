import type { JobRow } from "./types.js";

/**
 * The actual "work" a job represents. This lab is about claiming, leasing,
 * and retrying jobs, not about a realistic job-execution runtime, so
 * processing is intentionally trivial: a job whose payload carries
 * `shouldFail: true` (see packages/data-generators/src/jobs.ts and the
 * retries-and-failure scenario) always throws; every other job "succeeds"
 * immediately. Real workers would dispatch on `jobType` to send an email,
 * render a report, etc. - that dispatch is not the concept being taught
 * here, so it is deliberately a no-op.
 */
export async function processJob(job: JobRow): Promise<void> {
  if (job.payload.shouldFail === true) {
    throw new Error(`job ${job.id} (${job.jobType}) intentionally failed (payload.shouldFail)`);
  }
}
