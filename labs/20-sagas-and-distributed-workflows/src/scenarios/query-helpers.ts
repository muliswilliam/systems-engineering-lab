import type { Pool } from "pg";

/** Small, focused read helpers shared by the scenario scripts, the
 * choreography comparison, and the integration tests - all query real
 * table state rather than trusting a function's return value, per this
 * lab's "assert on real final row states, not just no error was thrown"
 * requirement. */

export async function getInventoryQuantity(pool: Pool, sku: string): Promise<number> {
  const result = await pool.query<{ available_quantity: number }>(
    "SELECT available_quantity FROM inventory_items WHERE sku = $1",
    [sku],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Unknown SKU "${sku}"`);
  }
  return row.available_quantity;
}

export async function getOrderStatus(pool: Pool, orderId: number): Promise<string> {
  const result = await pool.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Order ${orderId} does not exist`);
  }
  return row.status;
}

export async function getLatestReservationStatus(pool: Pool, orderId: number): Promise<string | null> {
  const result = await pool.query<{ status: string }>(
    "SELECT status FROM inventory_reservations WHERE order_id = $1 ORDER BY id DESC LIMIT 1",
    [orderId],
  );
  return result.rows[0]?.status ?? null;
}

export async function getLatestPaymentStatus(pool: Pool, orderId: number): Promise<string | null> {
  const result = await pool.query<{ status: string }>(
    "SELECT status FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1",
    [orderId],
  );
  return result.rows[0]?.status ?? null;
}

export async function getShipmentCount(pool: Pool, orderId: number): Promise<number> {
  const result = await pool.query<{ count: string }>("SELECT count(*) AS count FROM shipments WHERE order_id = $1", [
    orderId,
  ]);
  return Number(result.rows[0]?.count ?? 0);
}

export interface SagaLogSummary {
  entryCount: number;
  distinctActors: string[];
}

/**
 * `distinctActors` = every distinct `publishedBy`/`consumedBy` value found
 * in this order's `saga_log.detail` for the given mechanism. For
 * orchestration this is always empty (the orchestrator never records itself
 * as a named actor - it IS the one place all the logging comes from). For
 * choreography it is the set of "services" (order-service, inventory-
 * service, payment-service, shipment-service) a reader has to jump between
 * to reconstruct the full trace - the concrete number behind "choreography
 * is harder to observe" (see README "Observe").
 */
export async function getSagaLogSummary(pool: Pool, orderId: number, mechanism: string): Promise<SagaLogSummary> {
  const result = await pool.query<{ detail: { publishedBy?: string; consumedBy?: string } }>(
    "SELECT detail FROM saga_log WHERE order_id = $1 AND mechanism = $2",
    [orderId, mechanism],
  );
  const actors = new Set<string>();
  for (const row of result.rows) {
    if (row.detail?.publishedBy) actors.add(row.detail.publishedBy);
    if (row.detail?.consumedBy) actors.add(row.detail.consumedBy);
  }
  return { entryCount: result.rows.length, distinctActors: [...actors].sort() };
}
