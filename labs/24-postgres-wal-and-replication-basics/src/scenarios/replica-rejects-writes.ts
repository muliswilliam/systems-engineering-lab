import { createLogger } from "@labs/logging";
import { replicaPool, waitForDatabase } from "../db/replica-client.js";

const log = createLogger("lab24:scenario:replica-rejects-writes");

/**
 * A common real production incident: an application is misconfigured to
 * point (all or some) writes at a read replica instead of the primary. This
 * script reproduces that mistake directly and captures Postgres's real
 * rejection - a physical standby refuses writes at the SQL execution layer,
 * it is not something this repository's application code has to check for
 * itself.
 */
async function main() {
  await waitForDatabase(replicaPool);

  log.info("confirming the replica is in recovery (i.e. is actually a standby)");
  const recoveryCheck = await replicaPool.query<{ pg_is_in_recovery: boolean }>(
    "SELECT pg_is_in_recovery()",
  );
  log.info({ inRecovery: recoveryCheck.rows[0]?.pg_is_in_recovery }, "pg_is_in_recovery() on replica");

  log.info("attempting a direct INSERT against the replica connection");
  try {
    await replicaPool.query("INSERT INTO widgets (name, value) VALUES ($1, $2)", [
      "should-never-exist",
      1,
    ]);
    log.error("INSERT against the replica SUCCEEDED - this should be impossible for a physical standby");
    process.exitCode = 1;
  } catch (error) {
    const pgError = error as { code?: string; message?: string };
    log.info(
      { code: pgError.code, message: pgError.message },
      "INSERT against the replica was rejected by Postgres itself, as expected",
    );
  }

  await replicaPool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "replica-rejects-writes failed");
  process.exit(1);
});
