import { eq } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../db/primary-client.js";
import { replicaPool, waitForDatabase as waitForReplica } from "../db/replica-client.js";
import { userProfiles } from "../db/schema.js";
import {
  getReplicationLagFromPrimary,
  setReplicaApplyDelay,
  waitForReplicationCaughtUp,
} from "../lib/replication-control.js";

const log = createLogger("lab26:scenario:strategy-c-bounded-staleness");

const TRIALS = 15;
const ARTIFICIAL_DELAY_MS = 400;
// A byte-based threshold, not a time-based one - see
// getReplicationLagFromPrimary's doc comment (src/lib/replication-control.ts)
// for the real, empirically-observed reason: pg_stat_replication.replay_lag
// (an interval) only updates once the standby has actually REPLAYED a WAL
// record and confirmed it back to the primary. Under an active
// recovery_min_apply_delay, that confirmation is itself withheld, so
// replay_lag reads as small/zero for a while even though a real backlog is
// building up. pg_wal_lsn_diff-based bytes have no such lag-behind-the-lag
// problem - they reflect the WAL backlog size in real time.
const LAG_THRESHOLD_BYTES = 100;

/**
 * Strategy C: "bounded staleness." Instead of always routing to the primary
 * (Strategy A) or blocking until one specific write is confirmed replayed
 * (Strategy B), this strategy asks a cheap, real-time question before every
 * read: "how much WAL has the primary sent that the replica has not yet
 * replayed?" (`pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)` against
 * `pg_stat_replication` - the same view `packages/db-utils/sql/show-replication-lag.sql`
 * uses). If that backlog is under a configured byte threshold, read the
 * replica (fast, scales). If not, fall back to the primary for this read.
 *
 * This does NOT guarantee the read-after-write invariant for one specific
 * write the way Strategy B does - it is a policy about acceptable overall
 * staleness ("this page can tolerate a small amount of lag"), not "this
 * exact write must be visible."
 *
 * Part 1 runs under the same induced ~400ms `recovery_min_apply_delay` as
 * the other strategies and shows the fallback-to-primary path actually
 * triggering on every trial, immediately - the very first write already
 * produces a real WAL backlog well over the threshold, because replay is
 * being deliberately withheld the moment it commits. Part 2 removes the
 * artificial delay and shows the identical threshold logic choosing the
 * replica path instead, because the real measured backlog is genuinely
 * ~0 bytes - not because the code branches differently.
 */
interface TrialResult {
  route: "primary" | "replica";
  isCorrect: boolean;
  lagBytes: number;
  lagMs: number | null;
}

async function runTrials(label: string, trials: number): Promise<TrialResult[]> {
  const profiles = await primaryDb
    .select({ id: userProfiles.id, publicId: userProfiles.publicId })
    .from(userProfiles)
    .limit(trials);

  if (profiles.length < trials) {
    throw new Error(`need at least ${trials} seeded profiles - run "pnpm seed" first`);
  }

  const results: TrialResult[] = [];

  for (let i = 0; i < trials; i += 1) {
    const profile = profiles[i]!;
    const newName = `Bounded Staleness ${label} ${Date.now()}-${i}`;

    await primaryDb
      .update(userProfiles)
      .set({ displayName: newName, updatedAt: new Date() })
      .where(eq(userProfiles.id, profile.id));

    // A small, realistic buffer between "write commits" and "read arrives" -
    // in a real product this is the time for the write's HTTP response to
    // return and the client to issue its next request, never truly 0ms. It
    // also avoids a genuine (and separately real) measurement race: without
    // it, this check can occasionally land inside the same sub-millisecond
    // window real (non-delayed) streaming replication itself takes to
    // report a fresh commit, producing a rare, honest false-positive
    // fallback under NORMAL replication - not a bug, just a reminder that
    // any point-in-time check can land mid-write.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // STRATEGY C: measure the real-time WAL backlog (a general gauge, not
    // tied to this specific write's own LSN), then decide where to read from.
    const lag = await getReplicationLagFromPrimary(primaryPool);
    const route: "primary" | "replica" = lag.replayLagBytes > LAG_THRESHOLD_BYTES ? "primary" : "replica";

    const pool = route === "primary" ? primaryPool : replicaPool;
    const result = await pool.query<{ display_name: string }>(
      "SELECT display_name FROM user_profiles WHERE id = $1",
      [profile.id],
    );
    const observed = result.rows[0]?.display_name;
    const isCorrect = observed === newName;

    log.info(
      {
        trial: i + 1,
        publicId: profile.publicId,
        replayLagBytes: lag.replayLagBytes,
        replayLagMs: lag.replayLagMs,
        thresholdBytes: LAG_THRESHOLD_BYTES,
        route,
        expected: newName,
        observed,
        isCorrect,
      },
      `routed to ${route} because measured backlog was ${route === "primary" ? "over" : "under"} the byte threshold`,
    );

    results.push({ route, isCorrect, lagBytes: lag.replayLagBytes, lagMs: lag.replayLagMs });
  }

  return results;
}

function summarize(label: string, results: TrialResult[]) {
  const fallbackCount = results.filter((r) => r.route === "primary").length;
  const correctCount = results.filter((r) => r.isCorrect).length;
  log.info(
    {
      label,
      trials: results.length,
      fallbackToPrimaryCount: fallbackCount,
      fallbackRatePercent: Number(((fallbackCount / results.length) * 100).toFixed(0)),
      correctCount,
    },
    `${label} summary`,
  );
}

async function main() {
  await waitForPrimary(primaryPool);
  await waitForReplica(replicaPool);

  try {
    log.info(
      { artificialDelayMs: ARTIFICIAL_DELAY_MS, thresholdBytes: LAG_THRESHOLD_BYTES, trials: TRIALS },
      "Part 1: bounded staleness under induced lag - expect the fallback to PRIMARY to trigger every time",
    );
    await setReplicaApplyDelay(replicaPool, ARTIFICIAL_DELAY_MS);

    const withLag = await runTrials("with-lag", TRIALS);
    summarize("Part 1 (induced ~400ms recovery_min_apply_delay, 100-byte threshold)", withLag);

    log.info(
      { thresholdBytes: LAG_THRESHOLD_BYTES, trials: TRIALS },
      "Part 2: bounded staleness with normal (fast) replication - expect NO fallback to primary",
    );
    await setReplicaApplyDelay(replicaPool, 0);
    // Let the replica drain whatever small backlog Part 1 left behind before
    // measuring the "healthy" case - otherwise the first Part 2 trial or two
    // could still see a nonzero leftover backlog from Part 1's delay.
    await waitForReplicationCaughtUp(primaryPool, { timeoutMs: 3_000 }).catch(() => {
      // Best-effort only - each trial's own measurement is what is actually
      // asserted/logged below.
    });

    const withoutLag = await runTrials("no-lag", TRIALS);
    summarize("Part 2 (no artificial delay, 100-byte threshold)", withoutLag);
  } finally {
    log.info("resetting recovery_min_apply_delay back to 0 on the replica");
    await setReplicaApplyDelay(replicaPool, 0);
  }

  await primaryPool.end();
  await replicaPool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "strategy-c-bounded-staleness failed");
  process.exit(1);
});
