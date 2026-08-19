import { eq } from "drizzle-orm";
import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../db/primary-client.js";
import { replicaDb, replicaPool, waitForDatabase as waitForReplica } from "../db/replica-client.js";
import { products } from "../db/schema.js";
import { classifyNaive } from "../router/classify.js";
import { createRouter } from "../router/router.js";
import { withReplicaApplyDelay } from "../scripts/replica-apply-delay.js";

const log = createLogger("lab25:scenario:naive-router-stale-read");

const NATURAL_TRIALS = 100;
const DETERMINISTIC_TRIALS = 20;
const ARTIFICIAL_DELAY_MS = 150;

const naiveRouter = createRouter({ primaryDb, replicaDb, primaryPool, replicaPool, classify: classifyNaive });

async function seedProbeProduct(): Promise<number> {
  const [row] = await primaryDb
    .insert(products)
    .values({ name: "Naive-Router Race Probe", category: "electronics", priceCents: 1_000, stockQuantity: 100 })
    .returning({ id: products.id });
  if (!row) throw new Error("seed insert returned no row");
  return row.id;
}

/**
 * ONE trial of the actual bug: write a new price to the primary through the
 * naive router (correctly routed - writes always go to primary even in the
 * naive policy), then IMMEDIATELY read that same row back through the SAME
 * naive router's readAfterWrite - which the naive classify table sends to
 * the replica. Returns whether the read came back stale (i.e. did NOT
 * reflect the write this same trial just made).
 */
async function oneTrial(productId: number, newPriceCents: number): Promise<boolean> {
  await naiveRouter.write((db) =>
    db.update(products).set({ priceCents: newPriceCents, updatedAt: new Date() }).where(eq(products.id, productId)),
  );

  const [row] = await naiveRouter.readAfterWrite((db) =>
    db.select({ priceCents: products.priceCents }).from(products).where(eq(products.id, productId)),
  );

  return row?.priceCents !== newPriceCents;
}

async function main() {
  await waitForPrimary(primaryPool);
  await waitForReplica(replicaPool);

  const productId = await seedProbeProduct();

  log.info(
    { trials: NATURAL_TRIALS },
    "phase 1: NATURAL race - real streaming replication, no artificial delay, no fake timing",
  );
  let naturalStale = 0;
  for (let i = 0; i < NATURAL_TRIALS; i += 1) {
    const stale = await oneTrial(productId, 1_000 + i + 1);
    if (stale) naturalStale += 1;
  }
  log.info(
    { trials: NATURAL_TRIALS, staleCount: naturalStale, staleRate: Number((naturalStale / NATURAL_TRIALS).toFixed(3)) },
    "natural race result - a REAL observed stale-read rate via the naive router's read-after-write path, not hand-waved",
  );
  if (naturalStale === 0) {
    log.warn(
      "0 natural stale reads this run - real loopback replication can occasionally win every race by chance; phase 2 below makes the SAME bug reproducible on every run",
    );
  }

  log.info(
    { delayMs: ARTIFICIAL_DELAY_MS, trials: DETERMINISTIC_TRIALS },
    "phase 2: DETERMINISTIC race - real recovery_min_apply_delay active on the replica (same technique Lab 24 used)",
  );
  const deterministicStale = await withReplicaApplyDelay(replicaPool, ARTIFICIAL_DELAY_MS, async () => {
    let stale = 0;
    for (let i = 0; i < DETERMINISTIC_TRIALS; i += 1) {
      const isStale = await oneTrial(productId, 5_000 + i + 1);
      if (isStale) stale += 1;
    }
    return stale;
  });
  log.info(
    { trials: DETERMINISTIC_TRIALS, staleCount: deterministicStale },
    deterministicStale === DETERMINISTIC_TRIALS
      ? "every single trial was stale with the delay active - the naive router's read-after-write bug is now 100% reproducible, not a maybe"
      : "UNEXPECTED: not every trial was stale with the delay active - see README if this happens",
  );

  await primaryPool.end();
  await replicaPool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "naive-router-stale-read failed");
  process.exit(1);
});
