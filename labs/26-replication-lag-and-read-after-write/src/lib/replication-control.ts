import type { Pool } from "pg";

/**
 * Shared, real (never simulated) replication mechanics used by every
 * scenario and test in this lab. Nothing here fabricates timing - every
 * function issues an actual query against a real Postgres node.
 */

/**
 * Sets a real `recovery_min_apply_delay` on the replica - the same
 * documented Postgres standby feature Lab 24's `artificial-replication-lag.ts`
 * uses. It delays REPLAY of WAL the standby has already received, which is
 * what makes replication lag large enough to observe deterministically in a
 * script instead of racing a sub-millisecond window. `delayMs = 0` restores
 * normal (fast) replication.
 */
export async function setReplicaApplyDelay(replicaPool: Pool, delayMs: number): Promise<void> {
  // ALTER SYSTEM does not accept bind parameters - delayMs is always an
  // internal, hardcoded number in this lab's own code, never user input.
  await replicaPool.query(`ALTER SYSTEM SET recovery_min_apply_delay = '${delayMs}ms'`);
  await replicaPool.query("SELECT pg_reload_conf()");

  // recovery_min_apply_delay is a SIGHUP parameter - pg_reload_conf() applies
  // it, but SHOW in this same backend can briefly still report the old value
  // until the reload signal is processed, so poll for it. Postgres
  // normalizes a zero interval to the bare string "0" (no unit).
  const expected = delayMs === 0 ? "0" : `${delayMs}ms`;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await replicaPool.query<{ recovery_min_apply_delay: string }>(
      "SHOW recovery_min_apply_delay",
    );
    if (result.rows[0]?.recovery_min_apply_delay === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`replica never reported recovery_min_apply_delay = ${expected} after reload`);
}

/**
 * The primary's current WAL write position, right now. Strategy B (LSN-gated
 * reads) calls this immediately after a write commits and remembers the
 * result as the "I need to see at least this much WAL replayed" target.
 */
export async function getPrimaryWalLsn(primaryPool: Pool): Promise<string> {
  const result = await primaryPool.query<{ lsn: string }>("SELECT pg_current_wal_lsn() AS lsn");
  const lsn = result.rows[0]?.lsn;
  if (!lsn) {
    throw new Error("pg_current_wal_lsn() returned no value - is this connected to a primary?");
  }
  return lsn;
}

export interface LsnWaitResult {
  waitedMs: number;
  polls: number;
  replicaLsn: string;
}

/**
 * Blocks (via real polling, not a fixed sleep) until the replica's own
 * `pg_last_wal_replay_lsn()` has reached or passed `targetLsn`. This is the
 * heart of Strategy B: the caller supplies the LSN captured right after its
 * own write, and this function only returns once genuine WAL replay has
 * caught up to that point - not after some guessed delay.
 */
export async function waitForReplicaLsnAtLeast(
  replicaPool: Pool,
  targetLsn: string,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<LsnWaitResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 5;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const start = Date.now();
  let polls = 0;

  while (Date.now() - start < timeoutMs) {
    polls += 1;
    const result = await replicaPool.query<{ caught_up: boolean; replica_lsn: string }>(
      "SELECT (pg_last_wal_replay_lsn() >= $1::pg_lsn) AS caught_up, pg_last_wal_replay_lsn() AS replica_lsn",
      [targetLsn],
    );
    const row = result.rows[0];
    if (row?.caught_up) {
      return { waitedMs: Date.now() - start, polls, replicaLsn: row.replica_lsn };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `replica never reached target LSN ${targetLsn} within ${timeoutMs}ms - replication is not working`,
  );
}

export interface ReplicationLagSample {
  /** milliseconds, from pg_stat_replication.replay_lag; null if Postgres has not reported a value yet */
  replayLagMs: number | null;
  /** bytes of WAL sent but not yet replayed, from pg_wal_lsn_diff */
  replayLagBytes: number;
  state: string | null;
}

/**
 * Strategy C's measurement primitive: ask the PRIMARY how far behind it
 * believes the connected replica currently is, via `pg_stat_replication`.
 * This is a real, standard production observability query (the same shape
 * as `packages/db-utils/sql/show-replication-lag.sql`).
 *
 * This lab's README documents a real, empirically-observed caveat about the
 * two fields returned here: `replayLagMs` (from `pg_stat_replication.replay_lag`,
 * an interval) only updates once the standby has actually REPLAYED a WAL
 * record and reported that confirmation back to the primary - under an
 * active `recovery_min_apply_delay`, that confirmation is itself delayed, so
 * `replayLagMs` measured moments after a fresh write often reads as small or
 * zero even while real replay is being deliberately withheld. `replayLagBytes`
 * (from `pg_wal_lsn_diff`) has no such lag-behind-the-lag problem - it
 * reflects the WAL backlog size in real time, immediately after each write,
 * which is why this lab's Strategy C scenario routes on bytes rather than
 * the interval column. Both are real, standard Postgres observability
 * signals; they just answer subtly different questions ("how much
 * unreplayed WAL exists right now" vs. "how stale was the last thing we
 * actually confirmed replaying").
 */
export async function getReplicationLagFromPrimary(primaryPool: Pool): Promise<ReplicationLagSample> {
  const result = await primaryPool.query<{
    state: string | null;
    replay_lag_bytes: string | null;
    replay_lag_ms: string | null;
  }>(
    `SELECT
       state,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes,
       EXTRACT(EPOCH FROM replay_lag) * 1000 AS replay_lag_ms
     FROM pg_stat_replication
     WHERE state = 'streaming'
     LIMIT 1`,
  );
  const row = result.rows[0];
  return {
    state: row?.state ?? null,
    replayLagBytes: row?.replay_lag_bytes ? Number(row.replay_lag_bytes) : 0,
    replayLagMs: row?.replay_lag_ms != null ? Number(row.replay_lag_ms) : null,
  };
}

/**
 * Polls `getReplicationLagFromPrimary`'s byte-based measurement until the
 * WAL backlog drops to (or below) `thresholdBytes`. Used only to settle
 * transitional state - e.g. right after resetting `recovery_min_apply_delay`
 * back to 0, so a scenario's "no lag" trials do not start measuring while
 * the replica is still draining a small backlog accumulated during a prior
 * "with lag" phase. Bytes are used here (not the `replay_lag` interval)
 * because they reflect the real-time backlog size immediately, without
 * waiting for a replay-confirmation round trip - see
 * `getReplicationLagFromPrimary`'s doc comment for why that distinction
 * matters.
 */
export async function waitForReplicationCaughtUp(
  primaryPool: Pool,
  options: { thresholdBytes?: number; pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<ReplicationLagSample> {
  const thresholdBytes = options.thresholdBytes ?? 0;
  const pollIntervalMs = options.pollIntervalMs ?? 10;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const sample = await getReplicationLagFromPrimary(primaryPool);
    if (sample.replayLagBytes <= thresholdBytes) {
      return sample;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`replication backlog never dropped to <= ${thresholdBytes} bytes within ${timeoutMs}ms`);
}
