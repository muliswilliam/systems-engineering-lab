import { createLogger } from "@labs/logging";
import { primaryDb, primaryPool, waitForDatabase as waitForPrimary } from "../db/primary-client.js";
import { replicaDb, replicaPool, waitForDatabase as waitForReplica } from "../db/replica-client.js";
import { products } from "../db/schema.js";
import { classifyCorrected, classifyNaive } from "../router/classify.js";
import { createRouter } from "../router/router.js";

const log = createLogger("lab25:scenario:transaction-must-run-on-primary");

const naiveRouter = createRouter({ primaryDb, replicaDb, primaryPool, replicaPool, classify: classifyNaive });
const correctedRouter = createRouter({ primaryDb, replicaDb, primaryPool, replicaPool, classify: classifyCorrected });

async function seedProbeProduct(): Promise<number> {
  const [row] = await primaryDb
    .insert(products)
    .values({ name: "Transaction-Routing Probe", category: "electronics", priceCents: 1_000, stockQuantity: 100 })
    .returning({ id: products.id });
  if (!row) throw new Error("seed insert returned no row");
  return row.id;
}

interface PgError {
  code?: string;
  message?: string;
}

/**
 * A purchase must read the CURRENT stock and write the decremented stock
 * atomically - the textbook reason a "transaction" exists at all. `FOR
 * UPDATE` is deliberately raw SQL, not a Drizzle query builder call - row
 * locking is exactly the kind of PostgreSQL-specific behavior CLAUDE.md
 * asks this repository to express directly (see Lab 10).
 */
async function purchase(
  router: ReturnType<typeof createRouter>,
  productId: number,
  quantity: number,
): Promise<number> {
  return router.transaction(async (client) => {
    const result = await client.query<{ stock_quantity: number }>(
      "SELECT stock_quantity FROM products WHERE id = $1 FOR UPDATE",
      [productId],
    );
    const current = result.rows[0]?.stock_quantity;
    if (current === undefined) {
      throw new Error(`product ${productId} not found`);
    }
    if (current < quantity) {
      throw new Error(`insufficient stock: have ${current}, need ${quantity}`);
    }
    const newStock = current - quantity;
    await client.query("UPDATE products SET stock_quantity = $1, updated_at = now() WHERE id = $2", [
      newStock,
      productId,
    ]);
    return newStock;
  });
}

async function main() {
  await waitForPrimary(primaryPool);
  await waitForReplica(replicaPool);

  const productId = await seedProbeProduct();

  log.info(
    "attempt 1: naive router's classify table sends 'transaction' to the replica - purchase() will try SELECT ... FOR UPDATE there",
  );
  try {
    const newStock = await purchase(naiveRouter, productId, 10);
    log.error({ newStock }, "UNEXPECTED: the naive router's transaction SUCCEEDED against the replica");
    process.exitCode = 1;
  } catch (error) {
    const pgError = error as PgError;
    log.info(
      { code: pgError.code, message: pgError.message },
      "the naive router's transaction FAILED against the replica, exactly as it must - this is a real Postgres rejection, not a simulated one. A transaction that needs to write cannot be split onto a node that cannot write, and Postgres refuses even the locking SELECT that would make the write safe",
    );
  }

  log.info("attempt 2: corrected router's classify table sends 'transaction' to the primary");
  const newStock = await purchase(correctedRouter, productId, 10);
  log.info(
    { productId, quantityPurchased: 10, newStockQuantity: newStock, expectedStockQuantity: 90 },
    newStock === 90
      ? "the corrected router's transaction succeeded on the primary and correctly decremented stock"
      : "UNEXPECTED: stock quantity does not match the expected decrement",
  );

  await primaryPool.end();
  await replicaPool.end();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "transaction-must-run-on-primary failed");
  process.exit(1);
});
