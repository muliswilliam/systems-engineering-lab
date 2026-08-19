import { afterAll, beforeAll, it, expect } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { measureSingleWrite } from "../../src/scenarios/write-prober.js";
import { backfillLoyaltyPoints } from "../../src/scenarios/batched-resumable-backfill.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
}
const connectionString = process.env.DATABASE_URL;

const ROW_COUNT = 5_000;

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });

  await pool.query("TRUNCATE TABLE orders RESTART IDENTITY");
  const emails = Array.from({ length: ROW_COUNT }, (_, i) => `blocking-${i}@example.com`);
  const amounts = Array.from({ length: ROW_COUNT }, () => 1_500);
  const statuses = Array.from({ length: ROW_COUNT }, () => "paid");
  await pool.query(
    `INSERT INTO orders (customer_email, amount_cents, status)
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[])`,
    [emails, amounts, statuses],
  );
});

afterAll(async () => {
  await pool.end();
});

/**
 * The naive UPDATE's OWN execution time depends on dataset size and
 * machine speed - fine for the interactive `scenario:naive` demo against a
 * real large dataset (see README "Break it" for real captured numbers), but
 * a bad basis for a fast, deterministic test. Instead this test holds the
 * SAME real UPDATE's transaction open a bit longer with an explicit,
 * deliberate delay before COMMIT - the identical "hold a write-locking
 * transaction open for a controlled duration" idiom Lab 29's
 * `holdWriteLockingTransaction` uses - so the invariant under test (an
 * ordinary write against an already-touched row cannot proceed until the
 * giant UPDATE's transaction ends) is proven deterministically, via a real
 * SQLSTATE `55P03` lock-timeout error, not by racing wall-clock durations.
 */
it(
  "a single giant UPDATE holds its row locks until COMMIT - an ordinary concurrent write to an already-touched row is blocked, not just slowed down",
  async () => {
    const holder = new Client({ connectionString });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query(
      "UPDATE orders SET loyalty_points = floor(amount_cents / 100.0) WHERE loyalty_points IS NULL",
    );

    const holdMs = 400;
    const holderDone = (async () => {
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      await holder.query("COMMIT");
    })();

    const probeClient = new Client({ connectionString });
    await probeClient.connect();
    await probeClient.query("SET lock_timeout = '150ms'");

    const start = performance.now();
    await expect(probeClient.query("UPDATE orders SET status = status WHERE id = 1")).rejects.toMatchObject({
      code: "55P03",
    });
    const blockedForMs = performance.now() - start;
    await probeClient.end();

    // It genuinely waited close to its own lock_timeout before giving up,
    // and gave up well before the holder's transaction committed - proof
    // this was a real lock wait, not an already-resolved race.
    expect(blockedForMs).toBeGreaterThanOrEqual(130);
    expect(blockedForMs).toBeLessThan(holdMs);

    await holderDone;
    await holder.end();

    // Now that the holder has committed and released its row locks, an
    // ordinary write against the exact same row succeeds immediately.
    const afterCommitMs = await measureSingleWrite(connectionString, 1);
    expect(afterCommitMs).toBeLessThan(100);
  },
  10_000,
);

it(
  "a batched backfill does not meaningfully block an ordinary concurrent write to the same row",
  async () => {
    await pool.query("UPDATE orders SET loyalty_points = NULL");

    const backfillPromise = backfillLoyaltyPoints(pool, { batchSize: 200, sleepMs: 20 });

    // Row 1 is in the very first batch and is committed (and its lock
    // released) within milliseconds - by 30ms in, an ordinary write against
    // it should never be waiting on the backfill at all.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const duringMs = await measureSingleWrite(connectionString, 1);

    await backfillPromise;

    // Generous ceiling - real observed values are single-digit ms. What
    // matters is that this is nowhere close to the naive scenario's
    // multi-hundred-millisecond block above.
    expect(duringMs).toBeLessThan(500);
  },
  30_000,
);
