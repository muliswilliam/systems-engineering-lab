import { Client } from "pg";
import { createLogger } from "@labs/logging";
import { replicaPool, waitForDatabase as waitForReplica } from "../db/replica-client.js";
import { startService } from "../lib/docker-control.js";
import { attemptWrite, isInRecovery, waitUntilReachable } from "../lib/replication-control.js";

const log = createLogger("lab28:scenario:split-brain");

const PRIMARY_URL = process.env.PRIMARY_DATABASE_URL!;
const REPLICA_URL = process.env.REPLICA_DATABASE_URL!;

/**
 * PRECONDITION: run `pnpm scenario:failover` first. This script picks up
 * exactly where that one leaves off - old primary container stopped,
 * replica promoted - and demonstrates the classic split-brain risk CLAUDE.md
 * and this lab's brief both call out: a naively-restarted old primary does
 * NOT automatically know it should become a replica of the newly-promoted
 * node. It has no idea a promotion ever happened. It just... starts, as the
 * primary it always was, with its own on-disk WAL history frozen at the
 * moment it was stopped.
 *
 * This script does not attempt to fix that (per SPEC.md Lab 28's explicit
 * "do not attempt to build a production HA manager from scratch") - it only
 * makes the risk real and observable, then explains what a real fix
 * (pg_rewind or a fresh base backup) would require. It deliberately leaves
 * the lab in a broken, diverged state when it finishes - run `pnpm db:reset`
 * afterward before doing anything else in this lab.
 */
async function main() {
  await waitForReplica(replicaPool);

  const replicaInRecovery = await isInRecovery(replicaPool);
  if (replicaInRecovery !== false) {
    throw new Error(
      "the replica is still pg_is_in_recovery() = true - it has not been promoted yet. " +
        "Run `pnpm scenario:failover` first, then run this script.",
    );
  }

  const oldPrimaryStillDown = await attemptWrite(PRIMARY_URL, "should-fail-old-primary-still-down", 1);
  if (oldPrimaryStillDown.ok) {
    throw new Error(
      "the old primary container is already reachable and accepting writes - this script expects it to still be " +
        "stopped from `pnpm scenario:failover`. If you already restarted it, run `pnpm db:reset` and start over.",
    );
  }
  log.info(
    { connectionErrorCode: oldPrimaryStillDown.connectionErrorCode },
    "confirmed: old primary container is still stopped, replica is promoted - proceeding to naively restart the old primary",
  );

  // --- Naively bring the old primary back, exactly as an operator who
  // does not yet understand the risk might do -------------------------
  log.info("NAIVELY RESTARTING the old primary container - `docker compose start primary`, nothing else");
  await startService("primary");
  await waitUntilReachable(PRIMARY_URL, { timeoutMs: 30_000 });
  log.info("old primary container is back up and accepting connections");

  const oldPrimaryClient = new Client({ connectionString: PRIMARY_URL });
  await oldPrimaryClient.connect();

  const oldPrimaryRecovery = await oldPrimaryClient.query<{ pg_is_in_recovery: boolean }>(
    "SELECT pg_is_in_recovery()",
  );
  const promotedNodeRecovery = await isInRecovery(replicaPool);

  log.info(
    {
      oldPrimaryInRecovery: oldPrimaryRecovery.rows[0]?.pg_is_in_recovery,
      promotedNodeInRecovery: promotedNodeRecovery,
    },
    "SPLIT BRAIN, REAL AND OBSERVED: BOTH nodes now report pg_is_in_recovery() = false - both believe they are the primary",
  );
  if (oldPrimaryRecovery.rows[0]?.pg_is_in_recovery !== false || promotedNodeRecovery !== false) {
    throw new Error("expected both nodes to independently report pg_is_in_recovery() = false");
  }

  // --- Prove it's not just a status flag - the two nodes can now ------
  // --- independently accept DIFFERENT writes and diverge --------------
  await oldPrimaryClient.query("INSERT INTO widgets (name, value) VALUES ($1, $2)", [
    "written-to-OLD-primary-after-naive-restart",
    1,
  ]);
  const newPrimaryWrite = await attemptWrite(REPLICA_URL, "written-to-PROMOTED-node-independently", 2);
  if (!newPrimaryWrite.ok) {
    throw new Error("expected the promoted node to still accept writes");
  }

  const oldPrimaryRows = await oldPrimaryClient.query<{ name: string }>(
    "SELECT name FROM widgets WHERE name LIKE 'written-to-%' ORDER BY name",
  );
  const promotedNodeRows = await replicaPool.query<{ name: string }>(
    "SELECT name FROM widgets WHERE name LIKE 'written-to-%' ORDER BY name",
  );

  log.info(
    {
      oldPrimarySees: oldPrimaryRows.rows.map((r) => r.name),
      promotedNodeSees: promotedNodeRows.rows.map((r) => r.name),
    },
    "REAL DATA DIVERGENCE: each node now has a write the OTHER node has never seen and never will, unless an operator intervenes",
  );

  log.info(
    "WHAT WOULD ACTUALLY FIX THIS: the old primary cannot simply be pointed at the new primary and told to " +
      "'become a replica' - its data directory has DIVERGED (it has its own committed WAL history the new primary " +
      "never received). Reintroducing it safely requires either (a) pg_rewind, which finds the last common " +
      "checkpoint between the two timelines, rewinds the old primary's data directory back to that point (discarding " +
      "its diverged writes), and then lets it stream forward from the new primary as a real standby, or (b) wiping " +
      "the old primary's data directory entirely and taking a fresh base backup from the new primary, the same " +
      "bootstrap this lab's replica went through the first time. Neither is something this lab attempts to script - " +
      "per this lab's own scope, that is exactly the kind of decision real HA tooling (Patroni/repmgr/pg_auto_failover) " +
      "automates, and a from-scratch reimplementation here would teach the wrong lesson.",
  );

  log.info("this lab is now intentionally in a broken, diverged state - run `pnpm db:reset` before doing anything else with it");

  await oldPrimaryClient.end();
  await replicaPool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "split-brain-old-primary-returns failed");
  process.exit(1);
});
