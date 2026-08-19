import { performance } from "node:perf_hooks";
import { eq } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../db/primary-client.js";
import { replicaPool, waitForDatabase as waitForReplica } from "../db/replica-client.js";
import { userProfiles } from "../db/schema.js";
import { setReplicaApplyDelay } from "../lib/replication-control.js";

const log = createLogger("lab26:scenario:strategy-a-sticky-primary");

const TRIALS = 20;
const ARTIFICIAL_DELAY_MS = 400;
// A deliberately-too-short sticky window, used in Part 2 below to show the
// strategy's real limitation: it is a GUESS about how long lag will last,
// not a measurement of actual replication state.
const STICKY_WINDOW_MS = 250;

/**
 * Strategy A: "read your own writes go to the primary." The simplest
 * possible fix - any read the application knows follows a recent write by
 * the same session/user is routed straight back to the primary, bypassing
 * the replica (and its lag) entirely for that read.
 *
 * Part 1 shows it is always correct, on every trial, regardless of how much
 * real lag is present - because the read never touches the lagging replica
 * in the first place.
 *
 * Part 2 shows its real cost/limit: the "sticky window" is a client-side
 * GUESS about how long to keep routing to the primary. If real lag
 * (400ms here) outlasts the guessed window (250ms here), a read that
 * happens after the window "expires" but before the replica has actually
 * caught up is stale again - the strategy has no way to know this without
 * also checking real replication state (that is what Strategies B and C add).
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

  let correctCount = 0;

  try {
    log.info({ trials: TRIALS }, "Part 1: read-your-writes routed to PRIMARY, immediately after the write");
    for (let i = 0; i < TRIALS; i += 1) {
      const profile = profiles[i]!;
      const newName = `Sticky Primary ${Date.now()}-${i}`;

      await primaryDb
        .update(userProfiles)
        .set({ displayName: newName, updatedAt: new Date() })
        .where(eq(userProfiles.id, profile.id));

      // STRATEGY A: this session just wrote, so its own next read is routed
      // to the primary, not the replica - the read simply never sees lag.
      const result = await primaryPool.query<{ display_name: string }>(
        "SELECT display_name FROM user_profiles WHERE id = $1",
        [profile.id],
      );
      const observed = result.rows[0]?.display_name;
      const isCorrect = observed === newName;
      if (isCorrect) correctCount += 1;

      log.info(
        { trial: i + 1, publicId: profile.publicId, expected: newName, observed, isCorrect },
        "read-your-writes-to-primary result",
      );
    }

    log.info(
      { trials: TRIALS, correctCount, correctRatePercent: Number(((correctCount / TRIALS) * 100).toFixed(0)) },
      "Part 1 summary - always correct, because this read never touched the lagging replica",
    );

    log.info(
      { stickyWindowMs: STICKY_WINDOW_MS, artificialDelayMs: ARTIFICIAL_DELAY_MS },
      "Part 2: what happens once the sticky window 'expires' but real lag has not cleared yet",
    );

    const profile = profiles[0]!;
    const newName = `Sticky Window Expiry Probe ${Date.now()}`;
    await primaryDb
      .update(userProfiles)
      .set({ displayName: newName, updatedAt: new Date() })
      .where(eq(userProfiles.id, profile.id));
    const committedAt = performance.now();

    // Simulate the application's sticky-primary window elapsing - after
    // this, the app's own logic decides "enough time has passed, safe to
    // route back to the replica now." That decision is a guess, not a fact.
    const elapsed = performance.now() - committedAt;
    if (elapsed < STICKY_WINDOW_MS) {
      await new Promise((resolve) => setTimeout(resolve, STICKY_WINDOW_MS - elapsed));
    }

    const afterWindowResult = await replicaPool.query<{ display_name: string }>(
      "SELECT display_name FROM user_profiles WHERE id = $1",
      [profile.id],
    );
    const observedAfterWindow = afterWindowResult.rows[0]?.display_name;
    const staleAfterWindowExpired = observedAfterWindow !== newName;

    log.info(
      {
        publicId: profile.publicId,
        expected: newName,
        observed: observedAfterWindow,
        stickyWindowMs: STICKY_WINDOW_MS,
        artificialDelayMs: ARTIFICIAL_DELAY_MS,
        staleAfterWindowExpired,
      },
      staleAfterWindowExpired
        ? "as predicted: the sticky window (250ms) expired before real lag (400ms) cleared, so this read is STILL stale"
        : "read happened to be caught up already (real lag cleared faster than the sticky window this run)",
    );
  } finally {
    log.info("resetting recovery_min_apply_delay back to 0 on the replica");
    await setReplicaApplyDelay(replicaPool, 0);
  }

  await primaryPool.end();
  await replicaPool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "strategy-a-sticky-primary failed");
  process.exit(1);
});
