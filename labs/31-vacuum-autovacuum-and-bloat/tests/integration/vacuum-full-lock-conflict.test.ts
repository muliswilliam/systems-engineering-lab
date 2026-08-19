import { afterAll, beforeAll, it, expect } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { seedPageViewsFlushed } from "../../src/seed/seed.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
}
const connectionString = process.env.DATABASE_URL;

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await seedPageViewsFlushed(connectionString, 100);
});

afterAll(async () => {
  await pool.end();
});

/**
 * DETERMINISTIC proof of the real lock-mode conflict this lab's "Fix it"
 * section describes, rather than a probabilistic race against wall-clock
 * timing (the interactive `scenario:vacuum` script IS timing-based, per
 * README "Break it"/"Fix it" - this test proves the underlying MECHANISM
 * directly, the same "hold a lock, use lock_timeout, expect a real SQLSTATE"
 * idiom Lab 29/30 use for their own deterministic lock-blocking proofs).
 *
 * A holder transaction takes only the WEAKEST possible lock - an
 * `AccessShareLock`, acquired by an ordinary `SELECT` - and holds it open
 * for a controlled duration. `VACUUM FULL` needs an `ACCESS EXCLUSIVE` lock,
 * which conflicts with EVERY other lock mode including `AccessShareLock`, so
 * it must wait; plain `VACUUM` needs only a `ShareUpdateExclusiveLock`,
 * which does NOT conflict with `AccessShareLock`, so it proceeds immediately
 * even while the exact same holder transaction is still open.
 */
it(
  "VACUUM FULL is blocked by an ordinary concurrent reader's AccessShareLock; plain VACUUM is not",
  async () => {
    const holder = new Client({ connectionString });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM page_views LIMIT 1");

    const holdMs = 400;
    const holderDone = (async () => {
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      await holder.query("COMMIT");
    })();

    // --- VACUUM FULL: must wait for the holder's AccessShareLock to be
    // released - proven via a real SQLSTATE 55P03 lock-timeout rather than
    // waiting out the holder's full duration. ---
    const fullProbe = new Client({ connectionString });
    await fullProbe.connect();
    await fullProbe.query("SET lock_timeout = '150ms'");

    const fullStart = performance.now();
    await expect(fullProbe.query("VACUUM FULL page_views")).rejects.toMatchObject({ code: "55P03" });
    const fullBlockedForMs = performance.now() - fullStart;
    await fullProbe.end();

    expect(fullBlockedForMs).toBeGreaterThanOrEqual(130);
    expect(fullBlockedForMs).toBeLessThan(holdMs);

    await holderDone;
    await holder.end();

    // Now that the holder has committed and released its AccessShareLock, a
    // real VACUUM FULL succeeds immediately.
    await pool.query("VACUUM FULL page_views");
  },
  10_000,
);

it(
  "plain VACUUM proceeds immediately even while an ordinary concurrent reader holds an AccessShareLock",
  async () => {
    const holder = new Client({ connectionString });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM page_views LIMIT 1");

    try {
      const start = performance.now();
      await pool.query("VACUUM page_views");
      const durationMs = performance.now() - start;

      // Generous ceiling - what matters is that this is nowhere close to a
      // lock-timeout-style wait, proving ShareUpdateExclusiveLock genuinely
      // does not conflict with the holder's AccessShareLock.
      expect(durationMs).toBeLessThan(2_000);
    } finally {
      await holder.query("COMMIT");
      await holder.end();
    }
  },
  10_000,
);
