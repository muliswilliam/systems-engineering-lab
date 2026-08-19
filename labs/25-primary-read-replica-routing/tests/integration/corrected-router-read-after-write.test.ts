import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../../src/db/primary-client.js";
import { replicaDb, replicaPool, waitForDatabase as waitForReplica } from "../../src/db/replica-client.js";
import { products } from "../../src/db/schema.js";
import { classifyCorrected } from "../../src/router/classify.js";
import { captureCurrentLsn, waitForReplicaToReachLsn } from "../../src/router/lsn-wait.js";
import { createRouter } from "../../src/router/router.js";
import { withReplicaApplyDelay } from "../../src/scripts/replica-apply-delay.js";

beforeAll(async () => {
  await waitForPrimary(primaryPool);
  await migrate(primaryDb, { migrationsFolder: "drizzle" });
  await waitForReplica(replicaPool);
});

afterAll(async () => {
  await primaryPool.end();
  await replicaPool.end();
});

const ARTIFICIAL_DELAY_MS = 150;
const TRIALS = 20;

describe("corrected router - read-after-write is never stale under the same real replica lag", () => {
  it("route-to-primary strategy: zero stale reads across every trial", async () => {
    const correctedRouter = createRouter({
      primaryDb,
      replicaDb,
      primaryPool,
      replicaPool,
      classify: classifyCorrected,
    });

    const [seeded] = await primaryDb
      .insert(products)
      .values({ name: "corrected-fresh-read-test-row", category: "electronics", priceCents: 1_000, stockQuantity: 10 })
      .returning({ id: products.id });
    const productId = seeded!.id;

    const staleCount = await withReplicaApplyDelay(replicaPool, ARTIFICIAL_DELAY_MS, async () => {
      let stale = 0;
      for (let i = 0; i < TRIALS; i += 1) {
        const newPrice = 4_000 + i;
        await correctedRouter.write((db) =>
          db.update(products).set({ priceCents: newPrice }).where(eq(products.id, productId)),
        );
        const [row] = await correctedRouter.readAfterWrite((db) =>
          db.select({ priceCents: products.priceCents }).from(products).where(eq(products.id, productId)),
        );
        if (row?.priceCents !== newPrice) stale += 1;
      }
      return stale;
    });

    expect(staleCount).toBe(0);
  });

  it("LSN-wait strategy (alternate): also zero stale reads, while staying on the replica connection", async () => {
    const [seeded] = await primaryDb
      .insert(products)
      .values({ name: "corrected-lsn-wait-test-row", category: "electronics", priceCents: 1_000, stockQuantity: 10 })
      .returning({ id: products.id });
    const productId = seeded!.id;

    const staleCount = await withReplicaApplyDelay(replicaPool, ARTIFICIAL_DELAY_MS, async () => {
      let stale = 0;
      for (let i = 0; i < TRIALS; i += 1) {
        const newPrice = 6_000 + i;
        await primaryDb.update(products).set({ priceCents: newPrice }).where(eq(products.id, productId));
        const targetLsn = await captureCurrentLsn(primaryPool);
        await waitForReplicaToReachLsn(replicaPool, targetLsn);
        const [row] = await replicaDb
          .select({ priceCents: products.priceCents })
          .from(products)
          .where(eq(products.id, productId));
        if (row?.priceCents !== newPrice) stale += 1;
      }
      return stale;
    });

    expect(staleCount).toBe(0);
  });
});
