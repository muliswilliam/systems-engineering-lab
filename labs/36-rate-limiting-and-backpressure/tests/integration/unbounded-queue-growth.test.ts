import { describe, expect, it } from "vitest";
import { UnboundedQueue, runSlowConsumer } from "../../src/backpressure/unbounded-inprocess-queue.js";

/**
 * A fast, deterministic invariant test (the full memory/backlog-growth
 * measurement lives in the scenario script, which deliberately runs for a
 * few real seconds to produce human-readable numbers - not appropriate for
 * a test suite that should run in well under a second). The invariant this
 * test asserts: `UnboundedQueue.push` has NO capacity check at all - every
 * single push succeeds regardless of how far behind the consumer already
 * is, which is precisely the bug the bounded, Postgres-backed queue fixes.
 */
describe("unbounded in-process queue (naive backpressure failure mode)", () => {
  it("accepts every push with no capacity limit, even while a slow consumer is far behind", async () => {
    const queue = new UnboundedQueue();
    let stopConsumer = false;
    // A deliberately slow consumer that will not keep up with the burst below.
    const consumerPromise = runSlowConsumer(queue, 50, () => stopConsumer);
    consumerPromise.catch(() => {});

    const taskCount = 1_000;
    for (let i = 0; i < taskCount; i += 1) {
      queue.push({ id: i, submittedAt: Date.now(), payload: "x" });
    }

    // Immediately after the burst, essentially all 1,000 tasks are still
    // queued (the consumer, at 50ms/task, could not possibly have drained a
    // meaningful fraction of them yet) - no rejection, no cap, ever.
    expect(queue.length).toBeGreaterThan(taskCount - 5);

    // Don't wait for a full drain here (1,000 tasks * 50ms would make this
    // test itself slow) - `stopConsumer` only takes effect once the queue is
    // empty (see runSlowConsumer's doc comment), so the consumer is simply
    // abandoned once this test's assertion is made.
    stopConsumer = true;
  });
});
