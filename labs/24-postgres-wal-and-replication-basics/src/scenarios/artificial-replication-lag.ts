import { performance } from "node:perf_hooks";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../db/primary-client.js";
import { replicaPool, waitForDatabase as waitForReplica } from "../db/replica-client.js";
import { widgets } from "../db/schema.js";

const log = createLogger("lab24:scenario:artificial-replication-lag");

const BURST_SIZE = 50;
const ARTIFICIAL_DELAY_MS = 300;
const POLL_INTERVAL_MS = 5;
const POLL_TIMEOUT_MS = 5_000;

/**
 * This is not the read-after-write fix (that's Lab 26) - it exists so
 * replication lag is reliably, deterministically observable, instead of a
 * one-in-a-while flake. On a real workload, whether a race like this shows
 * a stale read depends on network distance, WAL volume, and replica I/O
 * pressure - on a local Docker Desktop loopback network with a tiny write
 * volume, real streaming replication is typically sub-millisecond (see
 * write-to-primary-observe-replica.ts's captured numbers), so racing a read
 * against it usually does NOT catch a gap.
 *
 * To make the gap real and reproducible without faking anything, this
 * script uses a genuine Postgres standby feature - `recovery_min_apply_delay`
 * - which tells the replica to deliberately wait before REPLAYING WAL it
 * has already received (this is a real, documented feature used in
 * production for "delayed replica" disaster-recovery topologies, not a
 * lab-only hack). The delay is applied on the standby itself; the primary
 * has no idea it exists.
 */
async function setReplicaApplyDelay(delayMs: number): Promise<void> {
  // ALTER SYSTEM does not accept bind parameters - delayMs is an internal,
  // hardcoded number (never user input), so building the literal directly
  // is safe here.
  await replicaPool.query(`ALTER SYSTEM SET recovery_min_apply_delay = '${delayMs}ms'`);
  await replicaPool.query("SELECT pg_reload_conf()");

  // recovery_min_apply_delay is a SIGHUP parameter - pg_reload_conf()
  // applies it, but SHOW in the SAME backend can briefly still report the
  // old value until the config-reload signal is processed, so poll for it.
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

async function main() {
  await waitForPrimary(primaryPool);
  await waitForReplica(replicaPool);

  log.info({ artificialDelayMs: ARTIFICIAL_DELAY_MS }, "setting a real recovery_min_apply_delay on the replica");
  await setReplicaApplyDelay(ARTIFICIAL_DELAY_MS);

  try {
    log.info({ burstSize: BURST_SIZE }, "writing a rapid burst to the primary");

    const burstStart = performance.now();
    let lastPublicId: string | undefined;
    for (let i = 0; i < BURST_SIZE; i += 1) {
      const [inserted] = await primaryDb
        .insert(widgets)
        .values({ name: `burst-probe-${i + 1}`, value: i + 1 })
        .returning({ publicId: widgets.publicId });
      lastPublicId = inserted?.publicId;
    }
    const burstEnd = performance.now();

    if (!lastPublicId) {
      throw new Error("burst insert produced no rows");
    }

    log.info(
      { burstSize: BURST_SIZE, burstDurationMs: Number((burstEnd - burstStart).toFixed(2)) },
      "burst committed on primary - racing a read against the replica for the LAST row now",
    );

    const raceCheck = await replicaPool.query("SELECT 1 FROM widgets WHERE public_id = $1", [lastPublicId]);
    const wasImmediatelyVisible = (raceCheck.rowCount ?? 0) > 0;
    log.info(
      { publicId: lastPublicId, wasImmediatelyVisible },
      wasImmediatelyVisible
        ? "the last burst row was ALREADY visible on the replica (unexpected with the apply delay active)"
        : "the last burst row is NOT YET visible on the replica - this is a real, deliberately-induced stale read, not simulated",
    );

    const pollStart = performance.now();
    let polls = 0;
    while (performance.now() - pollStart < POLL_TIMEOUT_MS) {
      polls += 1;
      const result = await replicaPool.query("SELECT 1 FROM widgets WHERE public_id = $1", [lastPublicId]);
      if ((result.rowCount ?? 0) > 0) {
        const caughtUpAt = performance.now();
        log.info(
          {
            publicId: lastPublicId,
            pollsUntilVisible: polls,
            catchUpMs: Number((caughtUpAt - burstEnd).toFixed(2)),
            configuredDelayMs: ARTIFICIAL_DELAY_MS,
          },
          "the replica has now caught up - the row is visible, roughly configuredDelayMs after commit",
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`replica never caught up within ${POLL_TIMEOUT_MS}ms - replication is not working`);
  } finally {
    // Reset the replica back to its default (no artificial delay) so every
    // OTHER scenario/test in this lab keeps seeing genuinely fast
    // replication, not a leftover 300ms lag from this script.
    log.info("resetting recovery_min_apply_delay back to 0 on the replica");
    await setReplicaApplyDelay(0);
    await primaryPool.end();
    await replicaPool.end();
  }
}

main().catch((error: unknown) => {
  log.error({ err: error }, "artificial-replication-lag failed");
  process.exit(1);
});
