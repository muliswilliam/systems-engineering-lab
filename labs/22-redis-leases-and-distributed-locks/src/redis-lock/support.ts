import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Redis } from "ioredis";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fresh, unguessable ownership token per lock acquisition attempt - never
 * reused across workers or across a single worker's retries. This is the
 * value stored as the lock key's value, not the lock key name itself. */
export function randomToken(): string {
  return randomUUID();
}

export function lockKeyFor(resourceName: string): string {
  return `lock:resource:${resourceName}`;
}

export function fencingCounterKeyFor(resourceName: string): string {
  return `fencing:resource:${resourceName}`;
}

export interface ResourceStateRow {
  id: number;
  publicId: string;
  name: string;
  fencingToken: number;
  lastWriter: string | null;
  updatedAt: string;
}

export async function readResourceState(pool: Pool, name: string): Promise<ResourceStateRow> {
  const { rows } = await pool.query<{
    id: number;
    public_id: string;
    name: string;
    fencing_token: string;
    last_writer: string | null;
    updated_at: string;
  }>("SELECT id, public_id, name, fencing_token, last_writer, updated_at FROM resource_state WHERE name = $1", [
    name,
  ]);
  const row = rows[0];
  if (!row) {
    throw new Error(`resource_state row "${name}" not found - run \`pnpm seed\` first`);
  }
  return {
    id: row.id,
    publicId: row.public_id,
    name: row.name,
    fencingToken: Number(row.fencing_token),
    lastWriter: row.last_writer,
    updatedAt: row.updated_at,
  };
}

/**
 * Idempotently resets one scenario's state to a known baseline before it
 * runs: the resource_state row's fencing_token/last_writer, and every Redis
 * key (lock key + fencing counter key) that scenario touches. Both the lock
 * key and the fencing counter key are deleted, not just the lock key -
 * leaving a stale fencing counter behind would let a rerun hand out fencing
 * tokens that no longer start from a value below what's already recorded on
 * the row, which would silently change which scenario runs actually
 * reproduce the "stale write rejected" outcome documented in the README.
 */
export async function resetScenarioState(pool: Pool, redis: Redis, resourceName: string): Promise<void> {
  await pool.query(
    `UPDATE resource_state SET fencing_token = 0, last_writer = NULL, updated_at = now() WHERE name = $1`,
    [resourceName],
  );
  await redis.del(lockKeyFor(resourceName), fencingCounterKeyFor(resourceName));
}

export async function writeResourceStateNaive(
  pool: Pool,
  name: string,
  writerId: string,
): Promise<{ rowCount: number }> {
  const result = await pool.query(
    `UPDATE resource_state SET last_writer = $1, updated_at = now() WHERE name = $2`,
    [writerId, name],
  );
  return { rowCount: result.rowCount ?? 0 };
}

/**
 * The fix's write path: a Postgres-native conditional write (the same
 * `UPDATE ... WHERE version = ?` shape Lab 11 teaches, using the fencing
 * token as the version). Only accepted if `fencingToken` is STRICTLY
 * GREATER than the value already recorded on the row - a write carrying an
 * older or equal token is a no-op (`rowCount = 0`), regardless of whether
 * the writer itself believes its lock is still valid.
 */
export async function writeResourceStateFenced(
  pool: Pool,
  name: string,
  writerId: string,
  fencingToken: number,
): Promise<{ rowCount: number }> {
  const result = await pool.query(
    `UPDATE resource_state
     SET fencing_token = $1, last_writer = $2, updated_at = now()
     WHERE name = $3 AND fencing_token < $1`,
    [fencingToken, writerId, name],
  );
  return { rowCount: result.rowCount ?? 0 };
}
