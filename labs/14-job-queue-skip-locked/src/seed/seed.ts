import { generateJobs } from "@labs/data-generators";
import { createLogger } from "@labs/logging";
import { db, pool, waitForDatabase } from "../db/client.js";
import { jobAttempts, jobs } from "../db/schema.js";

const log = createLogger("lab14:seed");

type Size = "small" | "medium" | "large";

/**
 * small:  quick single/five-worker demos and fast local iteration.
 * medium: a comfortable five-worker draining run with visible distribution.
 * large:  the 50-worker demo - enough jobs (250) that even 50 workers each
 *         claim several jobs, so the claim-distribution log is meaningful.
 */
const SIZE_PRESETS: Record<Size, number> = {
  small: 20,
  medium: 100,
  large: 250,
};

function parseArgs(): { seed: number; size: Size } {
  const args = process.argv.slice(2);
  const seedArg = args.find((a) => a.startsWith("--seed="));
  const sizeArg = args.find((a) => a.startsWith("--size="));
  const seed = seedArg ? Number(seedArg.split("=")[1]) : 42;
  const size = (sizeArg ? sizeArg.split("=")[1] : "small") as Size;

  if (!(size in SIZE_PRESETS)) {
    throw new Error(`Unknown --size "${size}". Use small, medium, or large.`);
  }

  return { seed, size };
}

/**
 * Idempotent: clears both tables (job_attempts first, since it references
 * jobs) and reinserts a fresh, deterministic batch of jobs every run -
 * running this twice with the same --seed produces the same logical batch
 * (SPEC.md 8.1). Every seeded job starts `pending` with a clean 0-attempts
 * count and no `shouldFail` payloads - the retries-and-failure and
 * lease-expiry-reclaim scenarios insert their own dedicated jobs on top of
 * (or independent of) this batch rather than relying on random failures
 * here, so a plain `pnpm seed && pnpm scenario:five` run always drains
 * cleanly to 100% completed.
 */
async function main() {
  const { seed, size } = parseArgs();
  const jobCount = SIZE_PRESETS[size];

  await waitForDatabase(pool);

  log.info({ seed, size, jobCount }, "clearing existing rows");
  await db.delete(jobAttempts);
  await db.delete(jobs);

  const generatedJobs = generateJobs(jobCount, seed, 0);
  const inserted = await db
    .insert(jobs)
    .values(generatedJobs.map((j) => ({ jobType: j.jobType, payload: j.payload })))
    .returning({ id: jobs.id });

  log.info({ seed, size, jobCount: inserted.length }, "seed complete");
  await pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "seed failed");
  process.exit(1);
});
