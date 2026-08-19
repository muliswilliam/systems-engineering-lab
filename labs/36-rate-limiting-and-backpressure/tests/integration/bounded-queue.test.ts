import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runConcurrently } from "@labs/test-utils";
import { pool } from "../../src/db/client.js";
import { enqueue, resetQueueState, runBoundedQueueWorker } from "../../src/backpressure/bounded-queue.js";
import { setupDatabase } from "./test-helpers.js";

beforeAll(async () => {
  await setupDatabase();
});

afterAll(async () => {
  await pool.end();
});

describe("bounded, Postgres-backed backpressure queue", () => {
  it("accepts exactly `capacity` concurrent enqueue attempts against an idle queue and rejects the rest", async () => {
    const capacity = 10;
    await resetQueueState(pool, capacity);

    const results = await runConcurrently(50, () => enqueue(pool));
    const accepted = results.filter((r) => r.status === "fulfilled" && r.value.accepted).length;

    expect(accepted).toBe(capacity);
    expect(results.length - accepted).toBe(50 - capacity);

    const { rows } = await pool.query<{ pending_count: number }>(
      "SELECT pending_count FROM queue_state WHERE id = 1",
    );
    expect(rows[0]?.pending_count).toBe(capacity);
  });

  it("never lets pending_count exceed capacity under sustained concurrent pressure while a worker drains it", async () => {
    const capacity = 5;
    await resetQueueState(pool, capacity);

    let stopWorker = false;
    const workerPromise = runBoundedQueueWorker(pool, "test-worker", 15, () => stopWorker);

    const pendingCountSamples: number[] = [];
    let sampleInFlight = false;
    const samplePoll = setInterval(() => {
      if (sampleInFlight) return;
      sampleInFlight = true;
      pool
        .query<{ pending_count: number }>("SELECT pending_count FROM queue_state WHERE id = 1")
        .then((res) => {
          const value = res.rows[0]?.pending_count;
          if (value !== undefined) pendingCountSamples.push(value);
        })
        .catch(() => {})
        .finally(() => {
          sampleInFlight = false;
        });
    }, 5);

    let accepted = 0;
    let rejected = 0;
    const start = Date.now();
    while (Date.now() - start < 500) {
      const result = await enqueue(pool);
      if (result.accepted) accepted += 1;
      else rejected += 1;
    }

    clearInterval(samplePoll);
    stopWorker = true;
    const processedByWorker = await workerPromise;

    expect(pendingCountSamples.length).toBeGreaterThan(0);
    expect(Math.max(...pendingCountSamples)).toBeLessThanOrEqual(capacity);
    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
    expect(processedByWorker).toBeGreaterThan(0);

    const { rows } = await pool.query<{ pending_count: number }>(
      "SELECT pending_count FROM queue_state WHERE id = 1",
    );
    expect(rows[0]?.pending_count).toBeLessThanOrEqual(capacity);
    expect(rows[0]?.pending_count).toBeGreaterThanOrEqual(0);
  });
});
