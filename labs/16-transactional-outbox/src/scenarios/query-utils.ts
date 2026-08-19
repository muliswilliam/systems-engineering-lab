import type { Pool } from "pg";

/**
 * Shared by every scenario script and the integration tests. Each scenario
 * run uses a unique `customerName` marker (a fresh UUID embedded in the
 * name) so tests can query exactly the rows one specific run produced,
 * without needing to truncate tables between scenarios or rely on
 * autoincrement id ranges.
 */
export async function countOrdersByCustomerName(pool: Pool, customerName: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::bigint AS count FROM orders WHERE customer_name = $1",
    [customerName],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function countOutboxEventsForOrder(pool: Pool, orderId: number): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::bigint AS count FROM outbox_events WHERE aggregate_id = $1",
    [orderId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export interface OrderWithOutboxEvent {
  orderId: number;
  customerName: string;
  amountCents: number;
  outboxEventId: number;
  eventType: string;
  publishedAt: Date | null;
}

/**
 * The join proving the outbox's core atomicity guarantee: an order and its
 * outbox event either both exist, visibly joinable in one query, or neither
 * does. Used by the transactional-outbox happy-path test.
 */
export async function findOrderWithOutboxEventByCustomerName(
  pool: Pool,
  customerName: string,
): Promise<OrderWithOutboxEvent[]> {
  const result = await pool.query<{
    order_id: number;
    customer_name: string;
    amount_cents: number;
    outbox_event_id: number;
    event_type: string;
    published_at: Date | null;
  }>(
    `SELECT o.id AS order_id, o.customer_name, o.amount_cents,
            e.id AS outbox_event_id, e.event_type, e.published_at
     FROM orders o
     JOIN outbox_events e ON e.aggregate_id = o.id
     WHERE o.customer_name = $1`,
    [customerName],
  );

  return result.rows.map((row) => ({
    orderId: row.order_id,
    customerName: row.customer_name,
    amountCents: row.amount_cents,
    outboxEventId: row.outbox_event_id,
    eventType: row.event_type,
    publishedAt: row.published_at,
  }));
}
