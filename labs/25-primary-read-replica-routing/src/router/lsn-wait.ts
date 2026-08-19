import { performance } from "node:perf_hooks";
import type { Pool } from "pg";

export interface LsnWaitResult {
  pollsUntilCaughtUp: number;
  waitedMs: number;
}

/**
 * An ALTERNATE strategy for read-after-write, offered alongside "just read
 * the primary" (which is what classifyCorrected/Router.readAfterWrite use
 * by default - see README "Why the fix works"). Instead of moving the read
 * to the primary, this keeps the read on the REPLICA but first waits for
 * the replica to prove - via its own real WAL replay position - that it has
 * caught up to at least the LSN the write produced on the primary.
 *
 * Why compare LSNs instead of a fixed `sleep(N)`?
 *
 * A fixed sleep is a guess about how long replication usually takes. Guess
 * too low and you reintroduce the exact bug this lab is about (still stale,
 * intermittently - the sleep just makes it rarer, not impossible). Guess
 * too high and every read-after-write pays that fixed cost even when the
 * replica actually caught up in 2ms (Lab 24 measured avgLagMs of 2.51 on a
 * local loopback network). Comparing LSNs answers the ACTUAL question -
 * "has the replica replayed at least this WAL position?" - directly,
 * instead of guessing at a proxy for it. Postgres exposes both sides of
 * that comparison natively: `pg_current_wal_lsn()` on the primary captured
 * at write time, and `pg_last_wal_replay_lsn()` on the replica, comparable
 * because `pg_lsn` supports ordering operators (`>=`) the same way a byte
 * offset would.
 */
export async function captureCurrentLsn(primaryPool: Pool): Promise<string> {
  const result = await primaryPool.query<{ lsn: string }>("SELECT pg_current_wal_lsn() AS lsn");
  const lsn = result.rows[0]?.lsn;
  if (!lsn) {
    throw new Error("pg_current_wal_lsn() returned no row");
  }
  return lsn;
}

export async function waitForReplicaToReachLsn(
  replicaPool: Pool,
  targetLsn: string,
  { pollIntervalMs = 5, timeoutMs = 5_000 }: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<LsnWaitResult> {
  const start = performance.now();
  let polls = 0;
  while (performance.now() - start < timeoutMs) {
    polls += 1;
    const result = await replicaPool.query<{ caught_up: boolean }>(
      "SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS caught_up",
      [targetLsn],
    );
    if (result.rows[0]?.caught_up) {
      return { pollsUntilCaughtUp: polls, waitedMs: performance.now() - start };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`replica never reached LSN ${targetLsn} within ${timeoutMs}ms`);
}
