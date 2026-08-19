import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../../src/db/primary-client.js";
import { replicaDb, replicaPool, waitForDatabase as waitForReplica } from "../../src/db/replica-client.js";
import { products } from "../../src/db/schema.js";
import { classifyCorrected, classifyNaive } from "../../src/router/classify.js";
import { createRouter, type Router } from "../../src/router/router.js";

beforeAll(async () => {
  await waitForPrimary(primaryPool);
  await migrate(primaryDb, { migrationsFolder: "drizzle" });
  await waitForReplica(replicaPool);
});

afterAll(async () => {
  await primaryPool.end();
  await replicaPool.end();
});

async function purchase(router: Router, productId: number, quantity: number): Promise<number> {
  return router.transaction(async (client) => {
    const result = await client.query<{ stock_quantity: number }>(
      "SELECT stock_quantity FROM products WHERE id = $1 FOR UPDATE",
      [productId],
    );
    const current = result.rows[0]!.stock_quantity;
    const newStock = current - quantity;
    await client.query("UPDATE products SET stock_quantity = $1 WHERE id = $2", [newStock, productId]);
    return newStock;
  });
}

describe("transactions must run entirely on the primary", () => {
  it("the naive router's transaction (routed to the replica) fails with a real Postgres read-only rejection", async () => {
    const naiveRouter = createRouter({ primaryDb, replicaDb, primaryPool, replicaPool, classify: classifyNaive });

    const [seeded] = await primaryDb
      .insert(products)
      .values({ name: "naive-transaction-test-row", category: "electronics", priceCents: 500, stockQuantity: 100 })
      .returning({ id: products.id });
    const productId = seeded!.id;

    await expect(purchase(naiveRouter, productId, 10)).rejects.toThrow(/read-only transaction/i);

    // Nothing should have changed - the transaction never got past its own
    // locking SELECT, let alone the UPDATE.
    const [after] = await primaryDb
      .select({ stockQuantity: products.stockQuantity })
      .from(products)
      .where(eq(products.id, productId));
    expect(after?.stockQuantity).toBe(100);
  });

  it("the corrected router's transaction (routed to the primary) succeeds and decrements stock correctly", async () => {
    const correctedRouter = createRouter({
      primaryDb,
      replicaDb,
      primaryPool,
      replicaPool,
      classify: classifyCorrected,
    });

    const [seeded] = await primaryDb
      .insert(products)
      .values({ name: "corrected-transaction-test-row", category: "electronics", priceCents: 500, stockQuantity: 100 })
      .returning({ id: products.id });
    const productId = seeded!.id;

    const newStock = await purchase(correctedRouter, productId, 10);
    expect(newStock).toBe(90);

    const [after] = await primaryDb
      .select({ stockQuantity: products.stockQuantity })
      .from(products)
      .where(eq(products.id, productId));
    expect(after?.stockQuantity).toBe(90);
  });
});
