import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../db/primary-client.js";
import { replicaPool, waitForDatabase as waitForReplica } from "../db/replica-client.js";
import { widgets } from "../db/schema.js";
import { stopService } from "../lib/docker-control.js";
import { attemptWrite, getReplicationStatus, isInRecovery, promote } from "../lib/replication-control.js";

const log = createLogger("lab28:scenario:failover-and-promote");

const PRIMARY_URL = process.env.PRIMARY_DATABASE_URL!;
const REPLICA_URL = process.env.REPLICA_DATABASE_URL!;

/**
 * THE FAILOVER, end to end, against a real two-node cluster:
 *
 *   1. confirm a healthy baseline (real pg_stat_replication / pg_is_in_recovery)
 *   2. write a canary row on the primary, confirm it replicates
 *   3. show the replica REJECTS a direct write (SQLSTATE 25006), same as Lab 24
 *   4. STOP the primary container for real (`docker compose stop primary`) -
 *      a genuine unplanned-outage-style failure, not a simulated one
 *   5. show the application-level consequence: a write aimed at "the primary"
 *      now fails with a connection-level error, not a SQL-level one
 *   6. call the real Postgres 12+ SQL function `pg_promote()` against the
 *      replica - standing in for whatever human or orchestration tool
 *      (Patroni/repmgr/pg_auto_failover) would make and trigger that
 *      decision in a real production system; Postgres does NOT do this on
 *      its own
 *   7. confirm pg_is_in_recovery() really flips from true to false
 *   8. show the SAME statement that was rejected in step 3 now SUCCEEDS
 *      against the promoted node
 *   9. measure, honestly, how long writes were unavailable ANYWHERE in the
 *      cluster, from the moment the primary is confirmed down to the moment
 *      a write against the promoted node succeeds
 *
 * This script leaves the old primary container STOPPED (not removed) and
 * the replica PROMOTED when it finishes - that is real, intentional
 * post-failover state, not a bug. Run `pnpm db:reset` to return to a fresh,
 * non-promoted baseline. See src/scenarios/split-brain-old-primary-returns.ts
 * for what happens if the old primary is naively restarted from here instead.
 */
async function main() {
  await waitForPrimary(primaryPool);
  await waitForReplica(replicaPool);

  // --- 1. Baseline ---------------------------------------------------
  const replicationStatus = await getReplicationStatus(primaryPool);
  const primaryInRecoveryBefore = await isInRecovery(primaryPool);
  const replicaInRecoveryBefore = await isInRecovery(replicaPool);
  log.info(
    { connectedReplicas: replicationStatus.length, primaryInRecoveryBefore, replicaInRecoveryBefore },
    "BASELINE: real two-node topology before anything happens",
  );
  if (replicationStatus.length !== 1 || replicationStatus[0]?.state !== "streaming") {
    throw new Error("expected exactly one streaming replica before starting the failover scenario");
  }

  // --- 2. Canary row, confirm replication ------------------------------
  const [canary] = await primaryDb
    .insert(widgets)
    .values({ name: "failover-canary", value: 1 })
    .returning({ publicId: widgets.publicId });
  const canaryDeadline = Date.now() + 5_000;
  let canaryVisible = false;
  while (Date.now() < canaryDeadline) {
    const result = await replicaPool.query("SELECT 1 FROM widgets WHERE public_id = $1", [canary?.publicId]);
    if ((result.rowCount ?? 0) > 0) {
      canaryVisible = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  log.info({ publicId: canary?.publicId, canaryVisible }, "canary row written on primary and confirmed on replica");
  if (!canaryVisible) throw new Error("canary row never replicated - aborting before touching the cluster");

  // --- 3. BEFORE promotion: the replica really rejects a write --------
  const beforeWrite = await attemptWrite(REPLICA_URL, "should-be-rejected-before-promotion", 1);
  log.info(
    { ok: beforeWrite.ok, sqlState: beforeWrite.sqlState, message: beforeWrite.message },
    "BEFORE PROMOTION: direct write against the replica - real Postgres rejection expected (SQLSTATE 25006, same as Lab 24)",
  );
  if (beforeWrite.ok || beforeWrite.sqlState !== "25006") {
    throw new Error(
      `expected the pre-promotion write to fail with SQLSTATE 25006, got ok=${beforeWrite.ok} sqlState=${beforeWrite.sqlState}`,
    );
  }

  // Close the long-lived primary pool BEFORE stopping its container. A
  // pg.Pool that has cached sockets to a container which then disappears
  // emits background 'error' events that this repository's @labs/db-utils
  // createPool does not attach a listener for - an unhandled Pool 'error'
  // event crashes the whole Node process. Every reachability check against
  // the primary from this point on uses a brand-new, short-lived pg.Client
  // instead (see attemptWrite/waitUntilUnreachable in replication-control.ts),
  // which is also a more honest simulation of "the next request from an
  // application" than reusing a pool that predates the outage.
  await primaryPool.end();

  // --- 4. THE FAILOVER: stop the primary container for real -----------
  log.info("STOPPING THE PRIMARY CONTAINER - a real `docker compose stop primary`, not a simulated failure");
  const stopStart = performance.now();
  await stopService("primary");
  const unavailabilityStart = performance.now();
  log.info(
    { stopDurationMs: Number((unavailabilityStart - stopStart).toFixed(2)) },
    "primary container is confirmed stopped by Docker itself - this is the moment writes become unavailable",
  );

  // --- 5. Application-level consequence: connection-level failure -----
  const duringOutageWrite = await attemptWrite(PRIMARY_URL, "should-fail-primary-is-down", 1);
  log.info(
    {
      ok: duringOutageWrite.ok,
      connectionErrorCode: duringOutageWrite.connectionErrorCode,
      message: duringOutageWrite.message,
      durationMs: Number(duringOutageWrite.durationMs.toFixed(2)),
    },
    "APPLICATION-LEVEL CONSEQUENCE: a write aimed at 'the primary' now fails at the CONNECTION level (not a SQL-level rejection like step 3) - this is what an application actually experiences during an unplanned outage window",
  );
  if (duringOutageWrite.ok) {
    throw new Error("write against the stopped primary unexpectedly succeeded - the container did not actually stop");
  }

  // --- 6. Trigger the failover: pg_promote() ---------------------------
  log.info(
    "TRIGGERING FAILOVER: calling pg_promote() on the replica. Postgres itself did NOT decide to do this - " +
      "this call stands in for whatever human or orchestration tool (Patroni/repmgr/pg_auto_failover) would make " +
      "and trigger that decision in a real production system. See README 'What does not automatically happen.'",
  );
  const promotion = await promote(replicaPool, 60);
  log.info(
    { promoted: promotion.promoted, durationMs: Number(promotion.durationMs.toFixed(2)) },
    "pg_promote() returned",
  );
  if (!promotion.promoted) {
    throw new Error("pg_promote() did not report a completed promotion within its wait_seconds budget");
  }

  // --- 7. Confirm the real role transition -----------------------------
  const inRecoveryAfter = await isInRecovery(replicaPool);
  log.info({ inRecoveryAfter }, "pg_is_in_recovery() on the (formerly standby) node, immediately after promotion");
  if (inRecoveryAfter !== false) {
    throw new Error(`expected pg_is_in_recovery() = false after promotion, got ${inRecoveryAfter}`);
  }

  // --- 8. The SAME kind of write now succeeds --------------------------
  let afterWrite = await attemptWrite(REPLICA_URL, "accepted-after-promotion", 1);
  let retries = 0;
  while (!afterWrite.ok && retries < 20) {
    retries += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    afterWrite = await attemptWrite(REPLICA_URL, "accepted-after-promotion", 1);
  }
  const unavailabilityEnd = performance.now();
  log.info(
    { ok: afterWrite.ok, retries, durationMs: Number(afterWrite.durationMs.toFixed(2)) },
    "AFTER PROMOTION: the SAME kind of INSERT that was rejected with SQLSTATE 25006 in step 3 now SUCCEEDS against the promoted node",
  );
  if (!afterWrite.ok) {
    throw new Error("write against the promoted node never succeeded within the retry budget");
  }

  // --- 9. The real, measured write-unavailability gap ------------------
  const gapMs = unavailabilityEnd - unavailabilityStart;
  log.info(
    {
      unavailabilityStartedAt: "primary container confirmed stopped",
      unavailabilityEndedAt: "first successful write against the promoted node",
      gapMs: Number(gapMs.toFixed(2)),
      promotionDurationMs: Number(promotion.durationMs.toFixed(2)),
      retriesAfterPromotion: retries,
    },
    "REAL MEASURED WRITE-UNAVAILABILITY GAP - no write succeeded anywhere in this cluster during this window",
  );

  log.info(
    "WHAT DID NOT HAPPEN AUTOMATICALLY: nothing in Postgres detected the primary's failure or decided to fail over " +
      "on its own - this script's explicit pg_promote() call and the human/tooling decision behind it were required. " +
      "The old primary container is now left STOPPED (not removed) - see README 'What does not automatically happen' " +
      "and 'split-brain' for what happens if it is naively restarted instead of rebuilt as a new replica.",
  );

  await replicaPool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "failover-and-promote failed");
  process.exit(1);
});
