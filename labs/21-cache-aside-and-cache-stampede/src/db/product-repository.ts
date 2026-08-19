import type { Pool } from "pg";

export interface Product {
  id: number;
  publicId: string;
  name: string;
  priceCents: number;
}

/**
 * Artificial delay standing in for an expensive product-detail computation
 * (a real system might join across price rules, inventory, personalization,
 * or run a slow full-text search) - per the lab brief, 50-100ms. This is the
 * thing Redis exists to protect the database from in this lab.
 */
export const SIMULATED_QUERY_DELAY_MS = 75;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps the slow "database" read with a call counter so every cache
 * scenario/test can assert a real, measured number of database calls rather
 * than a description of "the database would be overloaded." A fresh reader
 * (fresh counter) is created per scenario run / per test so counts never
 * leak between runs.
 */
export function createProductReader(pool: Pool) {
  let callCount = 0;

  async function getProductFromDatabase(productId: number): Promise<Product> {
    callCount += 1;
    await sleep(SIMULATED_QUERY_DELAY_MS);
    // `id` is a `bigint` column - node-postgres returns int8 values as
    // strings by default (they can exceed JS's safe integer range), so it
    // must be coerced explicitly rather than trusted as already numeric.
    const { rows } = await pool.query<{ id: string; public_id: string; name: string; price_cents: number }>(
      "SELECT id, public_id, name, price_cents FROM products WHERE id = $1",
      [productId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`Product ${productId} not found - run \`pnpm seed\` first`);
    }
    return { id: Number(row.id), publicId: row.public_id, name: row.name, priceCents: row.price_cents };
  }

  return {
    getProductFromDatabase,
    getCallCount: (): number => callCount,
    resetCallCount: (): void => {
      callCount = 0;
    },
  };
}

export type ProductReader = ReturnType<typeof createProductReader>;
