import type { Pool } from "pg";
import type { Logger } from "pino";

export interface OrderRow {
  id: number;
  publicId: string;
  customerEmail: string | null;
  amountCents: number;
  status: string;
  createdAt: string;
}

/**
 * The "-> database" step of this lab's HTTP -> business logic -> database ->
 * response trace. `opts.slow` issues a REAL `pg_sleep(0.3)` round trip
 * first - a genuinely slow query, not a `setTimeout` pretending to be one -
 * so the postgres-inspection scenario can later find it as a real,
 * in-flight, longer-than-usual query in `pg_stat_activity`.
 */
export async function findOrderById(pool: Pool, id: number, opts: { slow: boolean }, log: Logger): Promise<OrderRow | null> {
  log.info({ step: "db.query.start", orderId: id, slow: opts.slow }, "db query start");
  const start = performance.now();

  if (opts.slow) {
    await pool.query("SELECT pg_sleep(0.3)");
  }

  const result = await pool.query(
    `SELECT id,
            public_id AS "publicId",
            customer_email AS "customerEmail",
            amount_cents AS "amountCents",
            status,
            created_at AS "createdAt"
     FROM orders
     WHERE id = $1`,
    [id],
  );

  const durationMs = performance.now() - start;
  log.info({ step: "db.query.end", durationMs: Number(durationMs.toFixed(2)) }, "db query end");
  return (result.rows[0] as OrderRow | undefined) ?? null;
}

export interface NewOrderInput {
  customerEmail: string | null;
  amountCents: number;
}

export async function insertOrder(pool: Pool, input: NewOrderInput, log: Logger): Promise<OrderRow> {
  log.info({ step: "db.query.start" }, "db query start");
  const start = performance.now();
  const result = await pool.query(
    `INSERT INTO orders (customer_email, amount_cents)
     VALUES ($1, $2)
     RETURNING id,
               public_id AS "publicId",
               customer_email AS "customerEmail",
               amount_cents AS "amountCents",
               status,
               created_at AS "createdAt"`,
    [input.customerEmail, input.amountCents],
  );
  const durationMs = performance.now() - start;
  log.info({ step: "db.query.end", durationMs: Number(durationMs.toFixed(2)) }, "db query end");
  return result.rows[0] as OrderRow;
}
