import { performance } from "node:perf_hooks";
import { eq } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../db/primary-client.js";
import { replicaPool, waitForDatabase as waitForReplica } from "../db/replica-client.js";
import { userProfiles } from "../db/schema.js";
import { setReplicaApplyDelay } from "../lib/replication-control.js";

const log = createLogger("lab26:scenario:naive-stale-read-after-write");

const TRIALS = 20;
const ARTIFICIAL_DELAY_MS = 400;

/**
 * The bug this whole lab exists to fix, reproduced end to end:
 *
 *   POST /profile  -> UPDATE user_profiles SET display_name = ... (primary)
 *   redirect
 *   GET /profile   -> SELECT ... FROM user_profiles (replica, NO routing logic)
 *
 * A real `recovery_min_apply_delay` on the replica (the same real Postgres
 * feature Lab 24 uses, not a fake sleep) makes the replica's WAL replay
 * reliably lag ~400ms behind the primary, so the race is deterministic
 * across repeated trials instead of a rare flake that only shows up under
 * real network-separated production load.
 */
async function main() {
  await waitForPrimary(primaryPool);
  await waitForReplica(replicaPool);

  const profiles = await primaryDb
    .select({ id: userProfiles.id, publicId: userProfiles.publicId })
    .from(userProfiles)
    .limit(TRIALS);

  if (profiles.length < TRIALS) {
    throw new Error(`need at least ${TRIALS} seeded profiles - run "pnpm seed" first`);
  }

  log.info({ artificialDelayMs: ARTIFICIAL_DELAY_MS }, "inducing real replication lag via recovery_min_apply_delay");
  await setReplicaApplyDelay(replicaPool, ARTIFICIAL_DELAY_MS);

  let staleCount = 0;

  try {
    for (let i = 0; i < TRIALS; i += 1) {
      const profile = profiles[i]!;
      const newName = `Updated Name ${Date.now()}-${i}`;

      await primaryDb
        .update(userProfiles)
        .set({ displayName: newName, updatedAt: new Date() })
        .where(eq(userProfiles.id, profile.id));
      const committedAt = performance.now();

      // NAIVE: read the replica immediately, with no wait and no routing
      // decision at all - this is "the user is redirected straight to a
      // page that reads their own data back."
      const result = await replicaPool.query<{ display_name: string }>(
        "SELECT display_name FROM user_profiles WHERE id = $1",
        [profile.id],
      );
      const observed = result.rows[0]?.display_name;
      const isStale = observed !== newName;
      if (isStale) staleCount += 1;

      log.info(
        {
          trial: i + 1,
          publicId: profile.publicId,
          expected: newName,
          observed,
          isStale,
          msSinceCommit: Number((performance.now() - committedAt).toFixed(2)),
        },
        isStale
          ? "STALE READ: the user's own write just vanished on the replica"
          : "read was already up to date (replica had caught up before the read landed)",
      );
    }
  } finally {
    log.info("resetting recovery_min_apply_delay back to 0 on the replica");
    await setReplicaApplyDelay(replicaPool, 0);
  }

  log.info(
    {
      trials: TRIALS,
      staleCount,
      staleRatePercent: Number(((staleCount / TRIALS) * 100).toFixed(0)),
    },
    "naive read-after-write summary - real, repeated, captured stale reads under induced lag",
  );

  await primaryPool.end();
  await replicaPool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "naive-stale-read-after-write failed");
  process.exit(1);
});
