import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface PaymentRow {
  // `id` is a bigint column - the raw `pg` driver (unlike Drizzle's
  // `mode: "number"` column config, which only applies to queries run
  // through Drizzle itself) returns bigint values as strings by default, to
  // avoid silently losing precision above 2^53. Every scenario file in this
  // lab uses `pool.query` directly, so `id` is a string end to end here.
  id: string;
  public_id: string;
  idempotency_key: string | null;
  amount_cents: number;
  payee: string;
  status: string;
  confirmation_code: string | null;
  processing_fee_cents: number | null;
  created_at: Date;
}

/** A fresh payee name per scenario/test run, so concurrent runs (and reruns
 * against a non-reset database) never collide with each other's rows when
 * counting "how many rows exist for this one logical payment". */
export function scenarioPayee(label: string): string {
  return `${label} - ${randomUUID().slice(0, 8)}`;
}

export async function countPaymentsFor(pool: Pool, payee: string, amountCents: number): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM payments WHERE payee = $1 AND amount_cents = $2",
    [payee, amountCents],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function getPaymentsByIdempotencyKey(pool: Pool, idempotencyKey: string): Promise<PaymentRow[]> {
  const result = await pool.query<PaymentRow>("SELECT * FROM payments WHERE idempotency_key = $1", [
    idempotencyKey,
  ]);
  return result.rows;
}

export interface ProcessorResult {
  confirmationCode: string;
  processingFeeCents: number;
}

/**
 * Stands in for a call to a real payment processor's "process this charge"
 * endpoint. Real processors compute a fee (often a percentage plus a fixed
 * amount, sometimes with rate-card lookups that vary by time or account
 * tier) and hand back a confirmation code that is not something the caller
 * could ever reproduce by calling the function again. Modeled here with a
 * random component in BOTH fields specifically so that "the retry got back
 * the exact bytes from the first attempt" and "the retry silently
 * recomputed a new result" are impossible to confuse in a test or in
 * PGweb - two calls essentially never produce the same confirmation code or
 * fee by chance.
 */
export function callPaymentProcessor(amountCents: number): ProcessorResult {
  const confirmationCode = randomUUID().slice(0, 8).toUpperCase();
  const baseFeeCents = Math.round(amountCents * 0.029) + 30; // ~2.9% + $0.30
  const processorJitterCents = Math.floor(Math.random() * 5); // 0-4c of "live rate-card" noise
  return { confirmationCode, processingFeeCents: baseFeeCents + processorJitterCents };
}
