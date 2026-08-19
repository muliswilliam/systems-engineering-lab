import { sleep } from "../downstream/slow-downstream.js";

/**
 * The naive backpressure failure mode: a plain in-memory array with NO
 * capacity check at all. `push` always succeeds, no matter how far behind
 * the consumer already is. This is deliberately the simplest possible
 * "queue" - a real system might use an in-process array like this one, an
 * unbounded `Channel`/`EventEmitter` backlog, or an unbounded external queue
 * with no consumer-side flow control; the failure shape is the same in all
 * of them: backlog and per-item wait time grow without limit for as long as
 * the producer outpaces the consumer, and nothing in the system ever tells
 * the producer to slow down.
 */
export interface QueueTask {
  id: number;
  submittedAt: number;
  /** A junk payload string so real memory growth is measurable via `process.memoryUsage()`. */
  payload: string;
}

export class UnboundedQueue {
  private items: QueueTask[] = [];

  get length(): number {
    return this.items.length;
  }

  /** No capacity check - this is the bug. Every push succeeds. */
  push(task: QueueTask): void {
    this.items.push(task);
  }

  shift(): QueueTask | undefined {
    return this.items.shift();
  }
}

export interface ConsumerStats {
  processedCount: number;
  waitTimesMs: number[];
}

/**
 * A single slow consumer draining the queue one task at a time - stands in
 * for "one worker talking to a slow downstream." Runs until `shouldStop()`
 * returns true AND the queue is empty.
 */
export async function runSlowConsumer(
  queue: UnboundedQueue,
  perTaskMs: number,
  shouldStop: () => boolean,
): Promise<ConsumerStats> {
  const stats: ConsumerStats = { processedCount: 0, waitTimesMs: [] };

  for (;;) {
    const task = queue.shift();
    if (!task) {
      if (shouldStop()) {
        return stats;
      }
      await sleep(5);
      continue;
    }
    await sleep(perTaskMs);
    stats.processedCount += 1;
    stats.waitTimesMs.push(Date.now() - task.submittedAt);
  }
}
