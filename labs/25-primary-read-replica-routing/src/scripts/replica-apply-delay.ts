import type { Pool } from "pg";

/**
 * Same real Postgres standby feature Lab 24's `artificial-replication-lag.ts`
 * used (`recovery_min_apply_delay` - a genuine, documented feature used in
 * production for "delayed replica" disaster-recovery topologies) - extracted
 * here into a small shared module because THIS lab needs it in three
 * places: the naive-router scenario (to make the bug reproducible on every
 * run, not just sometimes), the corrected-router scenario (to prove the fix
 * holds even under real lag), and the integration tests for both.
 *
 * Without an artificial delay, real streaming replication on a local Docker
 * Desktop loopback network is fast enough (Lab 24 measured avgLagMs of 2.51)
 * that an immediate read-after-write race against the naive router mostly -
 * but not always - loses. That natural, honest "sometimes" flakiness IS the
 * real bug (see the "natural race" phase in naive-router-stale-read.ts) but
 * is a poor foundation for a reliable, repeatable lab exercise or test
 * suite. Setting a real, bounded delay on the standby's WAL REPLAY (not on
 * the network, not simulated) makes the exact same real bug reproducible on
 * every single run.
 */
export async function setReplicaApplyDelay(replicaPool: Pool, delayMs: number): Promise<void> {
  // ALTER SYSTEM does not accept bind parameters - delayMs is always an
  // internal, hardcoded constant in this lab (never user input), so
  // building the literal directly is safe here.
  await replicaPool.query(`ALTER SYSTEM SET recovery_min_apply_delay = '${delayMs}ms'`);
  await replicaPool.query("SELECT pg_reload_conf()");

  // recovery_min_apply_delay is a SIGHUP parameter - pg_reload_conf()
  // applies it, but SHOW in the same backend can briefly still report the
  // old value until the reload signal is processed, so poll for it.
  // Postgres normalizes a zero interval to the bare string "0" (no unit).
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
 * Runs `fn` with a real artificial replay delay active on the replica, then
 * always resets it back to 0 afterward - even if `fn` throws - so no other
 * scenario or test in this lab is left seeing a leftover lag.
 */
export async function withReplicaApplyDelay<T>(
  replicaPool: Pool,
  delayMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  await setReplicaApplyDelay(replicaPool, delayMs);
  try {
    return await fn();
  } finally {
    await setReplicaApplyDelay(replicaPool, 0);
  }
}
