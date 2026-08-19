import { eq } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../db/primary-client.js";
import { replicaPool, waitForDatabase as waitForReplica } from "../db/replica-client.js";
import { userProfiles } from "../db/schema.js";
import { getPrimaryWalLsn, setReplicaApplyDelay, waitForReplicaLsnAtLeast } from "../lib/replication-control.js";

const log = createLogger("lab26:scenario:strategy-b-lsn-gated-read");

const TRIALS = 15;
const ARTIFICIAL_DELAY_MS = 400;

/**
 * Strategy B: "LSN-gated read." The client remembers the primary's WAL
 * position (`pg_current_wal_lsn()`) at write time, then polls the replica's
 * own `pg_last_wal_replay_lsn()` until it has reached or passed that exact
 * position before reading from the replica. Unlike Strategy A, this is not
 * a guess about how long to wait - it blocks only as long as REAL replay
 * catch-up actually takes, for THIS specific write.
 *
 * Part 1 runs this under the same induced ~400ms lag as the naive scenario
 * and Strategy A, and shows the measured wait time tracking the real delay
 * closely, with every read correct.
 *
 * Part 2 repeats the identical logic with the artificial delay removed, to
 * show the mechanism adapts - it does not always wait ~400ms, it waits only
 * as long as actually needed (here, real streaming replication is fast, per
 * Lab 24's own measured avgLagMs of ~2.5ms).
 */
async function runTrials(label: string, trials: number): Promise<{ avgWaitMs: number; correctCount: number }> {
  const profiles = await primaryDb
    .select({ id: userProfiles.id, publicId: userProfiles.publicId })
    .from(userProfiles)
    .limit(trials);

  if (profiles.length < trials) {
    throw new Error(`need at least ${trials} seeded profiles - run "pnpm seed" first`);
  }

  let correctCount = 0;
  const waits: number[] = [];

  for (let i = 0; i < trials; i += 1) {
    const profile = profiles[i]!;
    const newName = `LSN Gated ${label} ${Date.now()}-${i}`;

    await primaryDb
      .update(userProfiles)
      .set({ displayName: newName, updatedAt: new Date() })
      .where(eq(userProfiles.id, profile.id));

    // STRATEGY B: capture the primary's WAL position right after the write
    // commits, then block until the replica has genuinely replayed at
    // least that far.
    const writeLsn = await getPrimaryWalLsn(primaryPool);
    const { waitedMs, polls } = await waitForReplicaLsnAtLeast(replicaPool, writeLsn, { timeoutMs: 5_000 });
    waits.push(waitedMs);

    const result = await replicaPool.query<{ display_name: string }>(
      "SELECT display_name FROM user_profiles WHERE id = $1",
      [profile.id],
    );
    const observed = result.rows[0]?.display_name;
    const isCorrect = observed === newName;
    if (isCorrect) correctCount += 1;

    log.info(
      { trial: i + 1, publicId: profile.publicId, writeLsn, waitedMs, polls, expected: newName, observed, isCorrect },
      "LSN-gated read result",
    );
  }

  const avgWaitMs = waits.reduce((sum, v) => sum + v, 0) / waits.length;
  return { avgWaitMs, correctCount };
}

async function main() {
  await waitForPrimary(primaryPool);
  await waitForReplica(replicaPool);

  try {
    log.info({ artificialDelayMs: ARTIFICIAL_DELAY_MS, trials: TRIALS }, "Part 1: LSN-gated reads under induced lag");
    await setReplicaApplyDelay(replicaPool, ARTIFICIAL_DELAY_MS);
    const withLag = await runTrials("with-lag", TRIALS);
    log.info(
      {
        trials: TRIALS,
        correctCount: withLag.correctCount,
        avgWaitMs: Number(withLag.avgWaitMs.toFixed(2)),
        artificialDelayMs: ARTIFICIAL_DELAY_MS,
      },
      "Part 1 summary - always correct; the measured wait tracks the real induced delay",
    );

    log.info({ trials: TRIALS }, "Part 2: LSN-gated reads with normal (fast) replication, no artificial delay");
    await setReplicaApplyDelay(replicaPool, 0);
    const withoutLag = await runTrials("no-lag", TRIALS);
    log.info(
      { trials: TRIALS, correctCount: withoutLag.correctCount, avgWaitMs: Number(withoutLag.avgWaitMs.toFixed(2)) },
      "Part 2 summary - always correct; the wait is now tiny because real replication is fast, not because the mechanism changed",
    );
  } finally {
    log.info("resetting recovery_min_apply_delay back to 0 on the replica");
    await setReplicaApplyDelay(replicaPool, 0);
  }

  await primaryPool.end();
  await replicaPool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "strategy-b-lsn-gated-read failed");
  process.exit(1);
});
