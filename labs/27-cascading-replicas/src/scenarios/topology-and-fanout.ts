import { createLogger } from "@labs/logging";
import { primaryPool, waitForDatabase as waitForPrimary } from "../db/primary-client.js";
import { replica1Pool, waitForDatabase as waitForReplica1 } from "../db/replica1-client.js";
import { replica2Pool, waitForDatabase as waitForReplica2 } from "../db/replica2-client.js";
import { getDownstreamReplicationStats } from "../lib/replication-control.js";

const log = createLogger("lab27:scenario:topology-and-fanout");

/**
 * The single most important architectural point of this lab: confirm the
 * REAL topology at every tier, via `pg_stat_replication` queried on THREE
 * different nodes, not inferred from docker-compose.yml's config alone.
 *
 * `pg_stat_replication` is always "who is directly downstream of the node I
 * just queried" - never a global view of the whole cascade. So:
 *   - queried on the PRIMARY: shows only replica-1 (replica-2 never opens a
 *     connection to the primary at all);
 *   - queried on REPLICA-1: shows only replica-2 (replica-1 is
 *     simultaneously a standby of the primary AND an upstream of replica-2 -
 *     both roles held by the same Postgres process at once);
 *   - queried on REPLICA-2: shows zero rows (replica-2 has no downstream of
 *     its own - it is a leaf).
 *
 * This is also the concrete evidence for cascading replication's main
 * benefit: no matter how many leaf replicas eventually consume the data (in
 * this lab, one; in a real deployment, potentially many chained off
 * replica-1 or replica-2), the PRIMARY only ever serves ONE downstream
 * streaming connection. Fan-out load is pushed down the chain instead of
 * concentrated at the primary.
 */
async function main() {
  await waitForPrimary(primaryPool);
  await waitForReplica1(replica1Pool);
  await waitForReplica2(replica2Pool);

  const primaryDownstream = await getDownstreamReplicationStats(primaryPool);
  log.info(
    { connectedDownstream: primaryDownstream.length, rows: primaryDownstream },
    "pg_stat_replication queried ON THE PRIMARY - should show exactly replica-1, never replica-2",
  );

  const replica1Downstream = await getDownstreamReplicationStats(replica1Pool);
  log.info(
    { connectedDownstream: replica1Downstream.length, rows: replica1Downstream },
    "pg_stat_replication queried ON REPLICA-1 - should show exactly replica-2 (replica-1 acting as an upstream)",
  );

  const replica2Downstream = await getDownstreamReplicationStats(replica2Pool);
  log.info(
    { connectedDownstream: replica2Downstream.length, rows: replica2Downstream },
    "pg_stat_replication queried ON REPLICA-2 - should show zero rows, replica-2 is a leaf with no downstream",
  );

  const replica1RecoveryCheck = await replica1Pool.query<{ pg_is_in_recovery: boolean }>(
    "SELECT pg_is_in_recovery()",
  );
  const replica2RecoveryCheck = await replica2Pool.query<{ pg_is_in_recovery: boolean }>(
    "SELECT pg_is_in_recovery()",
  );
  log.info(
    {
      replica1InRecovery: replica1RecoveryCheck.rows[0]?.pg_is_in_recovery,
      replica2InRecovery: replica2RecoveryCheck.rows[0]?.pg_is_in_recovery,
    },
    "both nodes report pg_is_in_recovery() = true - replica-1 is simultaneously a standby (of primary) and an upstream (for replica-2)",
  );

  const primaryOk = primaryDownstream.length === 1 && primaryDownstream[0]?.state === "streaming";
  const replica1Ok = replica1Downstream.length === 1 && replica1Downstream[0]?.state === "streaming";
  const replica2Ok = replica2Downstream.length === 0;

  if (!primaryOk || !replica1Ok || !replica2Ok) {
    log.error(
      { primaryOk, replica1Ok, replica2Ok },
      "cascading topology does NOT match expectations - see rows above",
    );
    process.exitCode = 1;
  } else {
    log.info(
      { primaryOk, replica1Ok, replica2Ok },
      "cascading topology confirmed: primary -> replica-1 -> replica-2, primary fan-out stays at exactly 1 connection",
    );
  }

  await primaryPool.end();
  await replica1Pool.end();
  await replica2Pool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "topology-and-fanout failed");
  process.exit(1);
});
