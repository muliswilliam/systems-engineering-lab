import type { Pool } from "pg";

export interface SampleIds {
  customerIdWithOrders: number;
  orderIdWithLines: number;
  productIdWithLines: number;
  sampleSku: string;
  sampleEmail: string;
}

/**
 * Picks real, existing IDs to run the demo queries against, instead of
 * hardcoding `id = 1` (which might have zero orders/lines depending on
 * random generation) or using `random()` (which would make before/after
 * timing comparisons run against different rows). Picking once per script
 * run and reusing the same IDs for every query in that run keeps the
 * before/after comparison apples-to-apples.
 */
export async function pickSampleIds(pool: Pool): Promise<SampleIds> {
  const customerResult = await pool.query<{ customer_id: string }>(
    `SELECT customer_id FROM orders GROUP BY customer_id HAVING count(*) >= 3 ORDER BY customer_id LIMIT 1`,
  );
  const orderResult = await pool.query<{ order_id: string }>(
    `SELECT order_id FROM order_lines GROUP BY order_id HAVING count(*) >= 2 ORDER BY order_id LIMIT 1`,
  );
  const productResult = await pool.query<{ product_id: string }>(
    `SELECT product_id FROM order_lines GROUP BY product_id HAVING count(*) >= 2 ORDER BY product_id LIMIT 1`,
  );
  const skuResult = await pool.query<{ sku: string }>(`SELECT sku FROM products ORDER BY id LIMIT 1`);
  const emailResult = await pool.query<{ email: string }>(`SELECT email FROM customers ORDER BY id LIMIT 1`);

  if (
    customerResult.rows.length === 0 ||
    orderResult.rows.length === 0 ||
    productResult.rows.length === 0 ||
    skuResult.rows.length === 0 ||
    emailResult.rows.length === 0
  ) {
    throw new Error(
      "could not find sample rows to query - run `pnpm seed` (or `pnpm seed --size=large`) first",
    );
  }

  return {
    customerIdWithOrders: Number(customerResult.rows[0]!.customer_id),
    orderIdWithLines: Number(orderResult.rows[0]!.order_id),
    productIdWithLines: Number(productResult.rows[0]!.product_id),
    sampleSku: skuResult.rows[0]!.sku,
    sampleEmail: emailResult.rows[0]!.email,
  };
}
