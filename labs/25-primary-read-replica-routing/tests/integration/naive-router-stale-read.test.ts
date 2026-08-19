import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../../src/db/primary-client.js";
import { replicaDb, replicaPool, waitForDatabase as waitForReplica } from "../../src/db/replica-client.js";
import { products } from "../../src/db/schema.js";
import { classifyNaive } from "../../src/router/classify.js";
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
const TRIALS = 10;

describe("naive router - read-after-write is stale under real replica lag", () => {
  it("every trial returns the PRE-write price, not the just-written one", async () => {
    const naiveRouter = createRouter({ primaryDb, replicaDb, primaryPool, replicaPool, classify: classifyNaive });

    const [seeded] = await primaryDb
      .insert(products)
      .values({ name: "naive-stale-read-test-row", category: "electronics", priceCents: 1_000, stockQuantity: 10 })
      .returning({ id: products.id });
    const productId = seeded!.id;

    const staleCount = await withReplicaApplyDelay(replicaPool, ARTIFICIAL_DELAY_MS, async () => {
      let stale = 0;
      for (let i = 0; i < TRIALS; i += 1) {
        const newPrice = 9_000 + i;
        await naiveRouter.write((db) =>
          db.update(products).set({ priceCents: newPrice }).where(eq(products.id, productId)),
        );
        const [row] = await naiveRouter.readAfterWrite((db) =>
          db.select({ priceCents: products.priceCents }).from(products).where(eq(products.id, productId)),
        );
        if (row?.priceCents !== newPrice) stale += 1;
      }
      return stale;
    });

    // A generous artificial delay (150ms) reliably exceeds this test's own
    // write+read round trip, so this must be deterministic - unlike Lab
    // 24's own natural-lag test, which uses a generous bound BECAUSE it is
    // timing-dependent, this assertion is exact because the delay is real
    // but the bug it triggers is not probabilistic once the delay exceeds
    // the round trip time.
    expect(staleCount).toBe(TRIALS);
  });
});
