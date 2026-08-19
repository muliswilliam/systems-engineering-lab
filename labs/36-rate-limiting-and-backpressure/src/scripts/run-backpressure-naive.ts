import "dotenv/config";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createLogger } from "@labs/logging";
import { sleep } from "../downstream/slow-downstream.js";
import { UnboundedQueue, runSlowConsumer } from "../backpressure/unbounded-inprocess-queue.js";

const log = createLogger("lab36:scenario:backpressure-naive");

const TASK_COUNT = 5_000;
// ~5KB of genuinely distinct random bytes per task (hex-encoded), so
// 5,000 tasks is ~25MB of real, measurable, non-deduplicatable payload.
// Deliberately NOT "x".repeat(N) - V8 represents a single-character
// repeated string far more cheaply than real distinct request payloads
// ever would be, which understates the real memory growth this scenario is
// trying to demonstrate.
const PAYLOAD_RANDOM_BYTES = 2_500;
const CONSUMER_PER_TASK_MS = 5;
const OBSERVATION_WINDOW_MS = 2_000;
const SAMPLE_INTERVAL_MS = 250;

function heapUsedMB(): number {
  return Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2));
}

/**
 * The naive backpressure failure mode: a producer submits work far faster
 * than a single slow consumer (standing in for one worker talking to a slow
 * downstream) can drain it, into a queue with NO capacity limit at all.
 * Nothing here ever tells the producer to slow down or rejects a submission
 * - the backlog and its memory footprint just keep growing for as long as
 * the imbalance continues. This is deliberately measured with a real
 * `process.memoryUsage()` payload (not asserted from theory) per the task
 * brief's "unbounded queue growth/memory growth if using an in-process
 * queue" framing.
 */
async function main(): Promise<void> {
  const queue = new UnboundedQueue();
  // Fire-and-forget: this lab's point is the BACKLOG that accumulates while
  // the consumer works through it far slower than the producer submits, not
  // a full drain (5,000 tasks * 5ms = 25s - much longer than this demo
  // needs to make its point).
  const consumerPromise = runSlowConsumer(queue, CONSUMER_PER_TASK_MS, () => false);
  consumerPromise.catch(() => {});

  const heapBeforeMB = heapUsedMB();

  log.info(
    { taskCount: TASK_COUNT, payloadRandomBytes: PAYLOAD_RANDOM_BYTES, consumerPerTaskMs: CONSUMER_PER_TASK_MS },
    "submitting a burst of tasks with no capacity check at all",
  );

  for (let i = 0; i < TASK_COUNT; i += 1) {
    queue.push({ id: i, submittedAt: Date.now(), payload: randomBytes(PAYLOAD_RANDOM_BYTES).toString("hex") });
  }

  const heapAfterProductionMB = heapUsedMB();

  log.warn(
    {
      taskCount: TASK_COUNT,
      queueLengthImmediatelyAfterProduction: queue.length,
      heapBeforeMB,
      heapAfterProductionMB,
      heapGrowthMB: Number((heapAfterProductionMB - heapBeforeMB).toFixed(2)),
    },
    "UNBOUNDED GROWTH: every single submitted task was accepted - nothing rejected it and nothing signaled the producer to slow down",
  );

  const samples: Array<{ atMs: number; queueLength: number; heapUsedMB: number }> = [];
  const observationStart = Date.now();
  while (Date.now() - observationStart < OBSERVATION_WINDOW_MS) {
    samples.push({ atMs: Date.now() - observationStart, queueLength: queue.length, heapUsedMB: heapUsedMB() });
    await sleep(SAMPLE_INTERVAL_MS);
  }

  log.warn(
    {
      samples,
      stillQueuedAfterObservationWindow: queue.length,
      consumedSoFar: TASK_COUNT - queue.length,
      observationWindowMs: OBSERVATION_WINDOW_MS,
    },
    "the backlog barely moved during the observation window - the consumer's fixed per-task latency, not any capacity limit, is the only thing gating drain speed",
  );

  process.exit(0);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "naive backpressure scenario failed");
    process.exit(1);
  });
}
