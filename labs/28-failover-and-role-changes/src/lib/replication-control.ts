import { Client, type Pool } from "pg";

/**
 * Shared, real (never simulated) primitives for this lab's baseline,
 * failover, and split-brain scenarios/tests. Every function here issues an
 * actual query or opens an actual TCP connection against a real Postgres
 * node or a real (possibly stopped) container - nothing is mocked.
 */

export interface ReplicationStatRow {
  application_name: string;
  state: string;
  sent_lsn: string;
  write_lsn: string;
  flush_lsn: string;
  replay_lsn: string;
  sync_state: string;
}

/** The primary's own view of every connected standby - empty when none is connected. */
export async function getReplicationStatus(primaryPool: Pool): Promise<ReplicationStatRow[]> {
  const result = await primaryPool.query<ReplicationStatRow>(
    `SELECT application_name, state, sent_lsn, write_lsn, flush_lsn, replay_lsn, sync_state
     FROM pg_stat_replication`,
  );
  return result.rows;
}

/** `true` on a standby (including a not-yet-promoted one), `false` on a normal read-write primary. */
export async function isInRecovery(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ pg_is_in_recovery: boolean }>("SELECT pg_is_in_recovery()");
  return Boolean(result.rows[0]?.pg_is_in_recovery);
}

export interface WriteAttemptResult {
  ok: boolean;
  durationMs: number;
  /** Postgres SQLSTATE (e.g. "25006") when the node rejected the write at the SQL layer - present only when `ok` is false AND the node was reachable. */
  sqlState?: string;
  /** node-postgres/libuv error code (e.g. "ECONNREFUSED") when the TCP connection itself could not be established - present only when the node is genuinely unreachable. */
  connectionErrorCode?: string;
  message?: string;
}

/**
 * Attempts one real INSERT against `connectionString` using a brand-new
 * `pg.Client` (never a long-lived Pool) so that a dead cached socket from
 * before a container stop can never produce a false "it's still up" or a
 * misleading error. This is deliberately how an application actually
 * experiences a database outage: the next real connection attempt either
 * gets rejected by Postgres (a live node saying "no") or never completes a
 * TCP handshake at all (a dead node saying nothing).
 */
export async function attemptWrite(connectionString: string, name: string, value: number): Promise<WriteAttemptResult> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 2_000 });
  const start = performance.now();
  try {
    await client.connect();
    await client.query("INSERT INTO widgets (name, value) VALUES ($1, $2)", [name, value]);
    return { ok: true, durationMs: performance.now() - start };
  } catch (error) {
    const pgError = error as { code?: string; message?: string };
    const durationMs = performance.now() - start;
    // node-postgres surfaces a real Postgres SQLSTATE (5 chars, e.g.
    // "25006") on the error's `code` field when the server itself rejected
    // the statement. A connection-level failure (server unreachable) also
    // sets `code`, but to a libuv/Node error name instead (ECONNREFUSED,
    // ETIMEDOUT, ...) - the two are distinguished here by shape, not by
    // guessing, since both arrive on the same field.
    const isSqlState = typeof pgError.code === "string" && /^[0-9A-Z]{5}$/.test(pgError.code) && !pgError.code.startsWith("E");
    return {
      ok: false,
      durationMs,
      sqlState: isSqlState ? pgError.code : undefined,
      connectionErrorCode: !isSqlState ? pgError.code : undefined,
      message: pgError.message,
    };
  } finally {
    await client.end().catch(() => {
      /* already broken - nothing more to clean up */
    });
  }
}

export interface PromotionResult {
  promoted: boolean;
  durationMs: number;
}

/**
 * Calls the real Postgres 12+ SQL function `pg_promote()` against a standby
 * - NOT a trigger file, NOT a signal, an actual SQL call any client with
 * sufficient privilege can issue. `wait: true` (the default, made explicit
 * here) blocks until Postgres reports the promotion has completed or
 * `waitSeconds` elapses, so the CALL ITSELF is the real, measured promotion
 * duration - no separate polling loop is required to know when it's done
 * (this function still returns `promoted: false` rather than throwing if
 * Postgres's own wait times out, so a caller can decide how to react).
 */
export async function promote(pool: Pool, waitSeconds = 60): Promise<PromotionResult> {
  const start = performance.now();
  const result = await pool.query<{ pg_promote: boolean }>("SELECT pg_promote(true, $1) AS pg_promote", [waitSeconds]);
  return {
    promoted: Boolean(result.rows[0]?.pg_promote),
    durationMs: performance.now() - start,
  };
}

/**
 * Polls a real TCP+SQL connection attempt (via `attemptWrite`-style probing
 * of `SELECT 1`, using a fresh Client each attempt) until the target node
 * accepts connections again, or `timeoutMs` elapses. Used to confirm "the
 * container is genuinely, fully down" and, separately, "the promoted node
 * is genuinely, fully back up" without guessing a fixed sleep duration.
 */
export async function waitUntilUnreachable(
  connectionString: string,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<{ waitedMs: number; polls: number }> {
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const start = Date.now();
  let polls = 0;

  while (Date.now() - start < timeoutMs) {
    polls += 1;
    const client = new Client({ connectionString, connectionTimeoutMillis: 500 });
    try {
      await client.connect();
      await client.end();
    } catch {
      return { waitedMs: Date.now() - start, polls };
    }
    await client.end().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`node at this connection string was still reachable after ${timeoutMs}ms`);
}

/**
 * The inverse of `waitUntilUnreachable` - polls until a real TCP+SQL
 * connection succeeds. Used after restarting a container (`docker compose
 * start ...`) to confirm Postgres inside it has actually finished starting
 * up before querying it, rather than guessing a fixed sleep duration.
 */
export async function waitUntilReachable(
  connectionString: string,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<{ waitedMs: number; polls: number }> {
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const start = Date.now();
  let polls = 0;

  while (Date.now() - start < timeoutMs) {
    polls += 1;
    const client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return { waitedMs: Date.now() - start, polls };
    } catch {
      await client.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  throw new Error(`node at this connection string was still unreachable after ${timeoutMs}ms`);
}
