import type { Pool } from "pg";

/**
 * Shared, real (never simulated) replication mechanics used by every
 * scenario and test in this lab. Nothing here fabricates timing - every
 * function issues an actual query against a real Postgres node. Every
 * function is generic over "some Postgres node's pool" rather than hardcoded
 * to a specific tier, because in a cascading topology the same primitives
 * apply at every hop: replica-1 is a standby (relative to the primary) AND
 * an upstream (relative to replica-2), so it needs both "act as a standby"
 * and "report on my own downstream" operations available on the same pool.
 *
 * This is a fresh, lab-local copy in the same spirit as Lab 26's own
 * `src/lib/replication-control.ts` - not imported from Lab 26, per the
 * independent-labs principle - generalized here to also expose the
 * upstream-node's-own-pg_stat_replication query Lab 26 did not need (Lab 26
 * only ever had one replica, so it never had to ask "what does THIS standby
 * see below itself").
 */

/**
 * Sets a real `recovery_min_apply_delay` on the given node - the same
 * documented Postgres standby feature Lab 24/26 use. It delays REPLAY of WAL
 * the standby has already received, which is what makes replication lag
 * large enough to observe deterministically in a script instead of racing a
 * sub-millisecond window. `delayMs = 0` restores normal (fast) replication.
 * Calling this against the primary (which is not in recovery) is a no-op at
 * the Postgres level - the setting only has an effect on a standby.
 */
export async function setApplyDelay(pool: Pool, delayMs: number): Promise<void> {
  // ALTER SYSTEM does not accept bind parameters - delayMs is always an
  // internal, hardcoded number in this lab's own code, never user input.
  await pool.query(`ALTER SYSTEM SET recovery_min_apply_delay = '${delayMs}ms'`);
  await pool.query("SELECT pg_reload_conf()");

  // recovery_min_apply_delay is a SIGHUP parameter - pg_reload_conf() applies
  // it, but SHOW in this same backend can briefly still report the old value
  // until the reload signal is processed, so poll for it. Postgres
  // normalizes a zero interval to the bare string "0" (no unit).
  const expected = delayMs === 0 ? "0" : `${delayMs}ms`;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ recovery_min_apply_delay: string }>(
      "SHOW recovery_min_apply_delay",
    );
    if (result.rows[0]?.recovery_min_apply_delay === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`node never reported recovery_min_apply_delay = ${expected} after reload`);
}

/**
 * The node's current WAL write position, right now (only meaningful on the
 * primary or, in a cascade, on a node acting as an upstream for a
 * downstream standby - `pg_current_wal_lsn()` requires the node not be in
 * recovery itself... actually in Postgres, a standby uses
 * `pg_last_wal_receive_lsn()` for the analogous "how far has this node
 * itself received" concept. This helper is used only against nodes that are
 * NOT in recovery, i.e. the primary.
 */
export async function getPrimaryWalLsn(pool: Pool): Promise<string> {
  const result = await pool.query<{ lsn: string }>("SELECT pg_current_wal_lsn() AS lsn");
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
 * Blocks (via real polling, not a fixed sleep) until the given standby's own
 * `pg_last_wal_replay_lsn()` has reached or passed `targetLsn`. Works
 * identically whether `pool` is replica-1 (comparing against the primary's
 * LSN) or replica-2 (comparing against replica-1's LSN, or the primary's,
 * once replica-2 has caught all the way up) - LSNs are a single global
 * ordering that both standbys converge toward.
 */
export async function waitForLsnAtLeast(
  pool: Pool,
  targetLsn: string,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<LsnWaitResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 5;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const start = Date.now();
  let polls = 0;

  while (Date.now() - start < timeoutMs) {
    polls += 1;
    const result = await pool.query<{ caught_up: boolean; replica_lsn: string }>(
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
    `node never reached target LSN ${targetLsn} within ${timeoutMs}ms - replication is not working`,
  );
}

export interface ReplicationStatRow {
  application_name: string;
  state: string;
  sent_lsn: string;
  write_lsn: string;
  flush_lsn: string;
  replay_lsn: string;
  sync_state: string;
}

/**
 * Reads `pg_stat_replication` from the given node's OWN point of view - i.e.
 * "which downstream standbys are currently connected to and streaming from
 * ME." Calling this against the primary shows only replica-1 (replica-2
 * never connects to the primary). Calling this SAME function against
 * replica-1 shows only replica-2 - this is the key evidence for the whole
 * lab: `pg_stat_replication` is not a global topology view, it is always
 * "who is downstream of the node I just queried."
 */
export async function getDownstreamReplicationStats(pool: Pool): Promise<ReplicationStatRow[]> {
  const result = await pool.query<ReplicationStatRow>(
    `SELECT application_name, state, sent_lsn, write_lsn, flush_lsn, replay_lsn, sync_state
     FROM pg_stat_replication`,
  );
  return result.rows;
}

/**
 * Polls a node's own WAL replay position and reports whether a given
 * public_id-keyed row is visible yet - used by the lag scenarios to measure
 * real (not fabricated) hop-by-hop propagation time.
 */
export async function waitForRowVisible(
  pool: Pool,
  publicId: string,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<{ waitedMs: number; polls: number }> {
  const pollIntervalMs = options.pollIntervalMs ?? 5;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const start = Date.now();
  let polls = 0;

  while (Date.now() - start < timeoutMs) {
    polls += 1;
    const result = await pool.query("SELECT 1 FROM widgets WHERE public_id = $1", [publicId]);
    if ((result.rowCount ?? 0) > 0) {
      return { waitedMs: Date.now() - start, polls };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`row ${publicId} never became visible within ${timeoutMs}ms`);
}
