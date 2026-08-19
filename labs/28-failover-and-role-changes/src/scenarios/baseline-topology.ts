import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../db/primary-client.js";
import { replicaPool, waitForDatabase as waitForReplica } from "../db/replica-client.js";
import { widgets } from "../db/schema.js";
import { getReplicationStatus, isInRecovery } from "../lib/replication-control.js";

const log = createLogger("lab28:scenario:baseline-topology");

/**
 * Step 1 of this lab: confirm a REAL two-node primary/standby pair before
 * doing anything destructive to it. Run this first, always - the failover
 * scenario assumes this baseline is true.
 */
async function main() {
  await waitForPrimary(primaryPool);
  await waitForReplica(replicaPool);

  const replicationStatus = await getReplicationStatus(primaryPool);
  log.info(
    { connectedReplicas: replicationStatus.length, rows: replicationStatus },
    "pg_stat_replication on the primary",
  );
  if (replicationStatus.length !== 1 || replicationStatus[0]?.state !== "streaming") {
    throw new Error(
      "expected exactly one streaming replica connected to the primary - replication is not healthy, fix that before running the failover scenario",
    );
  }

  const primaryInRecovery = await isInRecovery(primaryPool);
  const replicaInRecovery = await isInRecovery(replicaPool);
  log.info({ primaryInRecovery, replicaInRecovery }, "pg_is_in_recovery() on each node");
  if (primaryInRecovery !== false || replicaInRecovery !== true) {
    throw new Error(
      `unexpected topology: primary.pg_is_in_recovery()=${primaryInRecovery}, replica.pg_is_in_recovery()=${replicaInRecovery} - expected false/true`,
    );
  }

  const [canary] = await primaryDb
    .insert(widgets)
    .values({ name: "baseline-canary", value: 1 })
    .returning({ publicId: widgets.publicId });
  log.info({ publicId: canary?.publicId }, "wrote a canary row on the primary");

  const deadline = Date.now() + 5_000;
  let visibleOnReplica = false;
  while (Date.now() < deadline) {
    const result = await replicaPool.query("SELECT 1 FROM widgets WHERE public_id = $1", [canary?.publicId]);
    if ((result.rowCount ?? 0) > 0) {
      visibleOnReplica = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  log.info({ visibleOnReplica }, "canary row replicated to the standby");
  if (!visibleOnReplica) {
    throw new Error("canary row never appeared on the replica - replication is not actually working");
  }

  log.info("baseline confirmed: real two-node primary/standby topology, replicating, both roles as expected");

  await primaryPool.end();
  await replicaPool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "baseline-topology failed");
  process.exit(1);
});
