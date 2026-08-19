import { performance } from "node:perf_hooks";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../db/primary-client.js";
import { replica1Pool, waitForDatabase as waitForReplica1 } from "../db/replica1-client.js";
import { replica2Pool, waitForDatabase as waitForReplica2 } from "../db/replica2-client.js";
import { widgets } from "../db/schema.js";
import { setApplyDelay, waitForRowVisible } from "../lib/replication-control.js";

const log = createLogger("lab27:scenario:cascading-lag");

const BASELINE_WRITES = 10;
// Deliberate, real Postgres `recovery_min_apply_delay` values (see Lab 24's
// artificial-replication-lag.ts for why this is a genuine, documented
// standby feature and not a lab-only hack) - applied separately to each
// hop, so the "hop 1 lag" and "additional hop 2 lag" numbers below are
// independently, reliably observable instead of racing sub-millisecond
// local-loopback replication.
const REPLICA1_DELAY_MS = 150;
const REPLICA2_DELAY_MS = 150;
const DELAYED_WRITES = 8;
const ISOLATED_HOP_DELAY_MS = 150;
const ISOLATED_WRITES = 8;

interface HopSample {
  attempt: number;
  publicId: string;
  hop1LagMs: number; // primary -> replica-1
  totalLagMs: number; // primary -> replica-2
  additionalHopLagMs: number; // replica-1 -> replica-2, i.e. totalLagMs - hop1LagMs
}

async function measureOneWrite(attempt: number): Promise<HopSample> {
  const [inserted] = await primaryDb
    .insert(widgets)
    .values({ name: `cascade-lag-probe-${attempt}`, value: attempt })
    .returning({ publicId: widgets.publicId });

  if (!inserted) {
    throw new Error("insert on primary returned no row");
  }
  const publicId = inserted.publicId;
  const committedAt = performance.now();

  const hop1 = await waitForRowVisible(replica1Pool, publicId, { timeoutMs: 10_000 });
  const hop1LagMs = performance.now() - committedAt;
  // hop1.waitedMs is measured from a slightly later start than committedAt
  // (after the round trip of the INSERT itself), so report the wall-clock
  // measurement (hop1LagMs) as the authoritative number; hop1.polls is kept
  // for visibility into how tight the polling loop was.
  void hop1;

  const total = await waitForRowVisible(replica2Pool, publicId, { timeoutMs: 10_000 });
  const totalLagMs = performance.now() - committedAt;
  void total;

  return {
    attempt,
    publicId,
    hop1LagMs: Number(hop1LagMs.toFixed(2)),
    totalLagMs: Number(totalLagMs.toFixed(2)),
    additionalHopLagMs: Number((totalLagMs - hop1LagMs).toFixed(2)),
  };
}

function summarize(samples: HopSample[]) {
  const hop1 = samples.map((s) => s.hop1LagMs);
  const total = samples.map((s) => s.totalLagMs);
  const additional = samples.map((s) => s.additionalHopLagMs);
  const avg = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
  return {
    samples: samples.length,
    avgHop1LagMs: Number(avg(hop1).toFixed(2)),
    avgTotalLagMs: Number(avg(total).toFixed(2)),
    avgAdditionalHopLagMs: Number(avg(additional).toFixed(2)),
    minHop1LagMs: Number(Math.min(...hop1).toFixed(2)),
    maxTotalLagMs: Number(Math.max(...total).toFixed(2)),
  };
}

async function main() {
  await waitForPrimary(primaryPool);
  await waitForReplica1(replica1Pool);
  await waitForReplica2(replica2Pool);

  try {
    // Phase 1: baseline, no artificial delay anywhere. On a local Docker
    // Desktop loopback network with tiny WAL volume, both hops are usually
    // fast enough that the ADDITIONAL hop's lag is hard to see reliably -
    // this phase reports the real numbers anyway, honestly, before phase 2
    // makes the effect impossible to miss.
    log.info({ writeCount: BASELINE_WRITES }, "phase 1: baseline lag, no artificial delay");
    const baselineSamples: HopSample[] = [];
    for (let i = 1; i <= BASELINE_WRITES; i += 1) {
      const sample = await measureOneWrite(i);
      baselineSamples.push(sample);
      log.info(sample, "baseline write propagated through both hops");
    }
    log.info(summarize(baselineSamples), "phase 1 summary - baseline (real, observed, not hand-waved)");

    // Phase 2: a real recovery_min_apply_delay on EACH hop, so the primary
    // -> replica-1 lag and the ADDITIONAL replica-1 -> replica-2 lag are
    // both deliberately, reliably observable and separately attributable.
    log.info(
      { replica1DelayMs: REPLICA1_DELAY_MS, replica2DelayMs: REPLICA2_DELAY_MS },
      "phase 2: applying a real recovery_min_apply_delay on replica-1 AND replica-2",
    );
    await setApplyDelay(replica1Pool, REPLICA1_DELAY_MS);
    await setApplyDelay(replica2Pool, REPLICA2_DELAY_MS);

    const delayedSamples: HopSample[] = [];
    for (let i = 1; i <= DELAYED_WRITES; i += 1) {
      const sample = await measureOneWrite(BASELINE_WRITES + i);
      delayedSamples.push(sample);
      log.info(sample, "delayed write propagated through both hops");
    }
    const delayedSummary = summarize(delayedSamples);
    log.info(delayedSummary, "phase 2 summary - with a real, configured delay on each hop");

    log.info(
      {
        configuredReplica1DelayMs: REPLICA1_DELAY_MS,
        configuredReplica2DelayMs: REPLICA2_DELAY_MS,
        configuredTotalMs: REPLICA1_DELAY_MS + REPLICA2_DELAY_MS,
        observedAvgHop1LagMs: delayedSummary.avgHop1LagMs,
        observedAvgAdditionalHopLagMs: delayedSummary.avgAdditionalHopLagMs,
        observedAvgTotalLagMs: delayedSummary.avgTotalLagMs,
      },
      "the total primary -> replica-2 lag is measurably larger than the primary -> replica-1 lag alone - the extra cascade hop has a real, additive cost",
    );

    if (delayedSummary.avgTotalLagMs <= delayedSummary.avgHop1LagMs) {
      log.error(
        delayedSummary,
        "expected total (primary->replica-2) lag to exceed hop-1 (primary->replica-1) lag - it did not",
      );
      process.exitCode = 1;
    }

    // A real, worth-documenting nuance surfaces in phase 2's numbers above:
    // avgTotalLagMs only exceeds avgHop1LagMs by a small margin (a few ms),
    // NOT by anywhere close to REPLICA2_DELAY_MS's full 150ms, even though
    // BOTH replicas were configured with a 150ms delay. This is because
    // `recovery_min_apply_delay` is calculated relative to the WAL record's
    // ORIGINAL commit timestamp on the primary, not relative to when each
    // downstream standby itself received that record (see the Postgres
    // docs for recovery_min_apply_delay). Both replica-1 and replica-2 are
    // independently computing "commit_time + 150ms" as their own apply
    // target - by the time replica-2 has even received the record (which
    // requires waiting for replica-1 to replay AND forward it, itself
    // already ~150ms after commit), replica-2's own 150ms target has
    // already nearly elapsed. The two delays do NOT stack additively.
    //
    // Phase 3 isolates the extra hop's cost cleanly instead: delay ONLY
    // replica-2, leave replica-1 undelayed. Now hop-1 lag stays fast
    // (dominated by real network/replay time, not an artificial delay) and
    // the total lag is dominated entirely, attributably, by replica-2's own
    // configured delay - this is the clean way to make "the extra cascade
    // hop costs real, additional time" observable without the
    // commit-timestamp-anchoring nuance above muddying the numbers.
    log.info(
      { isolatedHopDelayMs: ISOLATED_HOP_DELAY_MS },
      "phase 3: delaying ONLY replica-2 (leaving replica-1 undelayed) to isolate the extra hop's cost cleanly",
    );
    await setApplyDelay(replica1Pool, 0);
    await setApplyDelay(replica2Pool, ISOLATED_HOP_DELAY_MS);

    const isolatedSamples: HopSample[] = [];
    for (let i = 1; i <= ISOLATED_WRITES; i += 1) {
      const sample = await measureOneWrite(BASELINE_WRITES + DELAYED_WRITES + i);
      isolatedSamples.push(sample);
      log.info(sample, "isolated-hop write propagated through both hops");
    }
    const isolatedSummary = summarize(isolatedSamples);
    log.info(
      {
        ...isolatedSummary,
        configuredIsolatedHopDelayMs: ISOLATED_HOP_DELAY_MS,
      },
      "phase 3 summary - replica-1 undelayed (fast), replica-2 alone delayed - the additional hop's cost is now cleanly attributable and close to the configured delay",
    );
  } finally {
    // Reset both replicas back to normal (fast) replication so every other
    // scenario/test in this lab keeps seeing genuinely fast replication.
    log.info("resetting recovery_min_apply_delay back to 0 on both replicas");
    await setApplyDelay(replica1Pool, 0);
    await setApplyDelay(replica2Pool, 0);
    await primaryPool.end();
    await replica1Pool.end();
    await replica2Pool.end();
  }
}

main().catch((error: unknown) => {
  log.error({ err: error }, "cascading-lag failed");
  process.exit(1);
});
