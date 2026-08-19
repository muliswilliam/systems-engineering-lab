import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../db/primary-client.js";
import { replica1Pool, waitForDatabase as waitForReplica1 } from "../db/replica1-client.js";
import { replica2Pool, waitForDatabase as waitForReplica2 } from "../db/replica2-client.js";
import { widgets } from "../db/schema.js";
import { getDownstreamReplicationStats, waitForRowVisible } from "../lib/replication-control.js";
import { startContainer, stopContainer, waitForContainerHealthy } from "../lib/docker-control.js";

const log = createLogger("lab27:scenario:upstream-failure");

const REPLICA1_CONTAINER = "lab27-replica-1";
const OUTAGE_OBSERVATION_MS = 3_000;

async function isRowVisible(pool: typeof primaryPool, publicId: string): Promise<boolean> {
  const result = await pool.query("SELECT 1 FROM widgets WHERE public_id = $1", [publicId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * The real operational tradeoff CLAUDE.md calls out for cascading
 * replication: reducing fan-out load on the primary means the middle tier
 * (replica-1) becomes a single point of failure for everything below it.
 * This script reproduces that concretely by genuinely stopping the
 * `lab27-replica-1` Docker container (a real SIGTERM/SIGKILL to a real
 * process, not a simulated failure) while the primary keeps accepting
 * writes, then shows replica-2 falls behind with NO path to catch up until
 * replica-1 itself comes back.
 */
async function main() {
  await waitForPrimary(primaryPool);
  await waitForReplica1(replica1Pool);
  await waitForReplica2(replica2Pool);

  // Sanity check: the cascade is healthy and a write reaches replica-2
  // before we break anything.
  const [before] = await primaryDb
    .insert(widgets)
    .values({ name: "upstream-failure-before-outage", value: 1 })
    .returning({ publicId: widgets.publicId });
  if (!before) throw new Error("insert on primary returned no row");
  await waitForRowVisible(replica2Pool, before.publicId, { timeoutMs: 10_000 });
  log.info({ publicId: before.publicId }, "sanity check passed: cascade is healthy before the outage");

  log.info({ container: REPLICA1_CONTAINER }, "stopping replica-1 - a genuine container stop, not simulated");
  await stopContainer(REPLICA1_CONTAINER);

  // The primary itself notices replica-1 disconnect - pg_stat_replication on
  // the primary should now show ZERO connected downstream nodes.
  const primaryViewDuringOutage = await getDownstreamReplicationStats(primaryPool);
  log.info(
    { connectedDownstream: primaryViewDuringOutage.length },
    "pg_stat_replication on the PRIMARY during the outage - replica-1 has dropped off entirely",
  );

  log.info("writing to the primary WHILE replica-1 is down");
  const [during] = await primaryDb
    .insert(widgets)
    .values({ name: "upstream-failure-during-outage", value: 2 })
    .returning({ publicId: widgets.publicId });
  if (!during) throw new Error("insert on primary returned no row during outage");
  log.info({ publicId: during.publicId }, "row committed on primary during the outage");

  log.info(
    { observationWindowMs: OUTAGE_OBSERVATION_MS },
    "confirming replica-2 does NOT receive the row - it has no path to the primary at all",
  );
  await new Promise((resolve) => setTimeout(resolve, OUTAGE_OBSERVATION_MS));
  const visibleOnReplica2DuringOutage = await isRowVisible(replica2Pool, during.publicId);
  log.info(
    { publicId: during.publicId, visibleOnReplica2: visibleOnReplica2DuringOutage },
    visibleOnReplica2DuringOutage
      ? "UNEXPECTED: replica-2 saw the row despite replica-1 being down"
      : "confirmed: replica-2 has NOT received the row - replica-1 is its only path to the primary, and that path is down",
  );

  if (visibleOnReplica2DuringOutage) {
    log.error("replica-2 should not have been able to see a write made while its only upstream was down");
    process.exitCode = 1;
  }

  log.info({ container: REPLICA1_CONTAINER }, "bringing replica-1 back up");
  await startContainer(REPLICA1_CONTAINER);
  await waitForContainerHealthy(REPLICA1_CONTAINER, { timeoutMs: 60_000 });
  log.info({ container: REPLICA1_CONTAINER }, "replica-1 is healthy again");

  // replica1Pool's underlying sockets may still reference the old (now-dead)
  // TCP connections from before the stop - `pg` transparently opens fresh
  // ones on the next query once the container is reachable again.
  await waitForReplica1(replica1Pool);

  log.info("waiting for replica-1 to resume streaming from the primary and replay the backlog");
  const replica1CatchUp = await waitForRowVisible(replica1Pool, during.publicId, { timeoutMs: 30_000 });
  log.info(replica1CatchUp, "replica-1 has caught up and now has the during-outage row");

  log.info("waiting for replica-2 to automatically catch up once replica-1 resumes forwarding");
  const replica2CatchUp = await waitForRowVisible(replica2Pool, during.publicId, { timeoutMs: 30_000 });
  log.info(replica2CatchUp, "replica-2 has automatically caught up - no manual intervention was needed beyond restarting replica-1");

  const primaryViewAfterRecovery = await getDownstreamReplicationStats(primaryPool);
  const replica1ViewAfterRecovery = await getDownstreamReplicationStats(replica1Pool);
  log.info(
    {
      primaryConnectedDownstream: primaryViewAfterRecovery.length,
      replica1ConnectedDownstream: replica1ViewAfterRecovery.length,
    },
    "cascade topology fully restored: primary sees replica-1 again, replica-1 sees replica-2 again",
  );

  await primaryPool.end();
  await replica1Pool.end();
  await replica2Pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "upstream-failure failed");
  process.exit(1);
});
