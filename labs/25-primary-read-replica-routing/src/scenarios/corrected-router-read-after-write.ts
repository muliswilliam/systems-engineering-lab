import { performance } from "node:perf_hooks";
import { eq } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../db/primary-client.js";
import { replicaDb, replicaPool, waitForDatabase as waitForReplica } from "../db/replica-client.js";
import { products } from "../db/schema.js";
import { classifyCorrected } from "../router/classify.js";
import { captureCurrentLsn, waitForReplicaToReachLsn } from "../router/lsn-wait.js";
import { createRouter } from "../router/router.js";
import { withReplicaApplyDelay } from "../scripts/replica-apply-delay.js";

const log = createLogger("lab25:scenario:corrected-router-read-after-write");

const ARTIFICIAL_DELAY_MS = 150;
const PRIMARY_STRATEGY_TRIALS = 50;
const LSN_WAIT_STRATEGY_TRIALS = 10;

const correctedRouter = createRouter({
  primaryDb,
  replicaDb,
  primaryPool,
  replicaPool,
  classify: classifyCorrected,
});

async function seedProbeProduct(): Promise<number> {
  const [row] = await primaryDb
    .insert(products)
    .values({ name: "Corrected-Router Race Probe", category: "electronics", priceCents: 1_000, stockQuantity: 100 })
    .returning({ id: products.id });
  if (!row) throw new Error("seed insert returned no row");
  return row.id;
}

/**
 * The FIX, default strategy: readAfterWrite is classified straight to the
 * primary. Simplest possible mechanism - the primary always has the value
 * it just committed, by definition, so there is nothing to wait for.
 */
async function primaryStrategyTrial(productId: number, newPriceCents: number): Promise<{ stale: boolean; latencyMs: number }> {
  await correctedRouter.write((db) =>
    db.update(products).set({ priceCents: newPriceCents, updatedAt: new Date() }).where(eq(products.id, productId)),
  );

  const readStart = performance.now();
  const [row] = await correctedRouter.readAfterWrite((db) =>
    db.select({ priceCents: products.priceCents }).from(products).where(eq(products.id, productId)),
  );
  const latencyMs = performance.now() - readStart;

  return { stale: row?.priceCents !== newPriceCents, latencyMs };
}

/**
 * The FIX, alternate strategy: keep the read on the replica, but PROVE
 * freshness first by waiting for the replica's own WAL replay position to
 * reach the LSN the write produced on the primary. See
 * src/router/lsn-wait.ts for why this beats a fixed sleep.
 */
async function lsnWaitStrategyTrial(productId: number, newPriceCents: number): Promise<{ stale: boolean; latencyMs: number }> {
  await correctedRouter.write((db) =>
    db.update(products).set({ priceCents: newPriceCents, updatedAt: new Date() }).where(eq(products.id, productId)),
  );
  const targetLsn = await captureCurrentLsn(primaryPool);

  const readStart = performance.now();
  await waitForReplicaToReachLsn(replicaPool, targetLsn);
  const [row] = await replicaDb.select({ priceCents: products.priceCents }).from(products).where(eq(products.id, productId));
  const latencyMs = performance.now() - readStart;

  return { stale: row?.priceCents !== newPriceCents, latencyMs };
}

async function main() {
  await waitForPrimary(primaryPool);
  await waitForReplica(replicaPool);

  const productId = await seedProbeProduct();

  await withReplicaApplyDelay(replicaPool, ARTIFICIAL_DELAY_MS, async () => {
    log.info(
      { delayMs: ARTIFICIAL_DELAY_MS, trials: PRIMARY_STRATEGY_TRIALS },
      "strategy 1: readAfterWrite routed straight to primary, under the SAME real replica lag that made the naive router 100% stale",
    );
    let primaryStale = 0;
    const primaryLatencies: number[] = [];
    for (let i = 0; i < PRIMARY_STRATEGY_TRIALS; i += 1) {
      const result = await primaryStrategyTrial(productId, 2_000 + i + 1);
      if (result.stale) primaryStale += 1;
      primaryLatencies.push(result.latencyMs);
    }
    const avgPrimaryLatency = primaryLatencies.reduce((a, b) => a + b, 0) / primaryLatencies.length;
    log.info(
      {
        trials: PRIMARY_STRATEGY_TRIALS,
        staleCount: primaryStale,
        avgReadLatencyMs: Number(avgPrimaryLatency.toFixed(2)),
      },
      primaryStale === 0
        ? "route-to-primary strategy: zero stale reads across every trial, and read latency is NOT bounded by replication lag"
        : "UNEXPECTED: route-to-primary strategy produced a stale read - this would mean the classify table itself is wrong",
    );

    log.info(
      { delayMs: ARTIFICIAL_DELAY_MS, trials: LSN_WAIT_STRATEGY_TRIALS },
      "strategy 2 (alternate): readAfterWrite kept on the replica, gated on pg_last_wal_replay_lsn() reaching the write's LSN",
    );
    let lsnStale = 0;
    const lsnLatencies: number[] = [];
    for (let i = 0; i < LSN_WAIT_STRATEGY_TRIALS; i += 1) {
      const result = await lsnWaitStrategyTrial(productId, 3_000 + i + 1);
      if (result.stale) lsnStale += 1;
      lsnLatencies.push(result.latencyMs);
    }
    const avgLsnLatency = lsnLatencies.reduce((a, b) => a + b, 0) / lsnLatencies.length;
    log.info(
      {
        trials: LSN_WAIT_STRATEGY_TRIALS,
        staleCount: lsnStale,
        avgReadLatencyMs: Number(avgLsnLatency.toFixed(2)),
        configuredDelayMs: ARTIFICIAL_DELAY_MS,
      },
      lsnStale === 0
        ? "LSN-wait strategy: also zero stale reads - but notice avgReadLatencyMs tracks configuredDelayMs, unlike strategy 1"
        : "UNEXPECTED: LSN-wait strategy produced a stale read",
    );

    log.info(
      "contrast: an ORDINARY read (correctedRouter.read) is legitimately allowed to see the pre-write value on the replica - that is not a bug",
    );
    await correctedRouter.write((db) =>
      db.update(products).set({ priceCents: 9_999, updatedAt: new Date() }).where(eq(products.id, productId)),
    );
    const [ordinaryRead] = await correctedRouter.read((db) =>
      db.select({ priceCents: products.priceCents }).from(products).where(eq(products.id, productId)),
    );
    const [readAfterWrite] = await correctedRouter.readAfterWrite((db) =>
      db.select({ priceCents: products.priceCents }).from(products).where(eq(products.id, productId)),
    );
    log.info(
      {
        justWrotePriceCents: 9_999,
        ordinaryReadFromReplicaSawPriceCents: ordinaryRead?.priceCents,
        readAfterWriteFromPrimarySawPriceCents: readAfterWrite?.priceCents,
      },
      "same moment, two different classifications, two different (both CORRECT for their kind) answers",
    );
  });

  await primaryPool.end();
  await replicaPool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "corrected-router-read-after-write failed");
  process.exit(1);
});
