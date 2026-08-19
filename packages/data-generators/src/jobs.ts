import { Faker, en } from "@faker-js/faker";

export interface GeneratedJob {
  jobType: string;
  payload: Record<string, unknown>;
}

/**
 * Background-processing domain (SPEC.md 8.2's "Background processing":
 * jobs, attempts, workers, schedules). Only `jobs` is genuinely reusable
 * across future queue-shaped labs (17's outbox workers are a different
 * table shape entirely) - `job_attempts` is scenario-specific to Lab 14
 * (it records claim/lease/retry bookkeeping this lab's worker code owns)
 * and is defined only in that lab's schema, per CLAUDE.md's guidance not to
 * build speculative shared machinery ahead of a second consumer needing it.
 *
 * Job types and payload shapes are a small, coherent slice of realistic
 * background work (notifications, reporting, media processing, payments,
 * inventory sync) rather than meaningless random records (SPEC.md 8.3).
 */
const JOB_TYPES = [
  "send_email",
  "generate_report",
  "resize_image",
  "process_payment",
  "sync_inventory",
] as const;

export type JobType = (typeof JOB_TYPES)[number];

function buildPayload(faker: Faker, jobType: JobType, shouldFail: boolean): Record<string, unknown> {
  const base = shouldFail ? { shouldFail: true } : {};
  switch (jobType) {
    case "send_email":
      return { ...base, to: faker.internet.email(), subject: faker.lorem.sentence(4) };
    case "generate_report":
      return { ...base, reportId: faker.string.uuid(), format: faker.helpers.arrayElement(["pdf", "csv"]) };
    case "resize_image":
      return {
        ...base,
        imageUrl: faker.internet.url(),
        width: faker.helpers.arrayElement([256, 512, 1024]),
        height: faker.helpers.arrayElement([256, 512, 1024]),
      };
    case "process_payment":
      return {
        ...base,
        orderId: faker.string.uuid(),
        amountCents: faker.number.int({ min: 500, max: 50_000 }),
      };
    case "sync_inventory":
      return { ...base, sku: faker.string.alphanumeric(8).toUpperCase(), delta: faker.number.int({ min: -20, max: 20 }) };
  }
}

/**
 * Generates a deterministic, seeded batch of background jobs. `failureRate`
 * (0-1) marks a proportion of jobs' payloads with `shouldFail: true`, which
 * this lab's worker code (`src/queue/process.ts`) treats as "always throw" -
 * used to seed a realistic mix rather than every scenario needing to hand-
 * construct its own always-failing job.
 */
export function generateJobs(count: number, seed: number, failureRate = 0): GeneratedJob[] {
  const faker = new Faker({ locale: en });
  // +4 offset keeps this generator's RNG sequence independent of the other
  // domain generators (payroll: seed, commerce: seed/seed+1, ledger: seed+3).
  faker.seed(seed + 4);

  return Array.from({ length: count }, () => {
    const jobType = faker.helpers.arrayElement(JOB_TYPES);
    const shouldFail = faker.number.float() < failureRate;
    return {
      jobType,
      payload: buildPayload(faker, jobType, shouldFail),
    };
  });
}
