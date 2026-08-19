import { Client } from "pg";

/**
 * These scenarios deliberately do NOT use Drizzle or the shared `pg.Pool`
 * from src/db/client.ts. Per CLAUDE.md's "ORM plus SQL" rule, row-lock
 * experiments need two (or three) genuinely independent, explicitly
 * controlled connections/transactions - `BEGIN`, `SELECT ... FOR UPDATE`, an
 * interleaved sequence of statements, then `COMMIT`/`ROLLBACK` - which a
 * query builder does not model well. Raw `pg.Client` connections make every
 * step of the interleaving explicit, reproducible, and (via `processID`)
 * identifiable in `pg_locks`/`pg_stat_activity`.
 */

export interface ConnectedClient {
  client: Client;
  /** The backend PID Postgres assigned this connection - used to scope
   * pg_locks/pg_stat_activity snapshots to exactly the connections this
   * scenario is driving, instead of guessing by relation name (which does
   * not work for `transactionid` lock rows - see snapshotLocks below). */
  pid: number;
}

export async function connectClient(connectionString: string): Promise<ConnectedClient> {
  const client = new Client({ connectionString });
  await client.connect();
  // node-postgres populates `processID` from the server's BackendKeyData
  // message once the connection handshake completes.
  const pid = (client as unknown as { processID: number }).processID;
  return { client, pid };
}

export async function getAccountId(connectionString: string, ownerName: string): Promise<number> {
  const { client } = await connectClient(connectionString);
  try {
    const { rows } = await client.query<{ id: number }>("SELECT id FROM accounts WHERE owner_name = $1", [
      ownerName,
    ]);
    if (!rows[0]) {
      throw new Error(`account "${ownerName}" not found - run \`pnpm seed\` first`);
    }
    return rows[0].id;
  } finally {
    await client.end();
  }
}

export async function resetAccountBalance(
  connectionString: string,
  ownerName: string,
  balanceCents: number,
): Promise<{ id: number }> {
  const { client } = await connectClient(connectionString);
  try {
    const { rows } = await client.query<{ id: number }>(
      "UPDATE accounts SET balance_cents = $1 WHERE owner_name = $2 RETURNING id",
      [balanceCents, ownerName],
    );
    if (!rows[0]) {
      throw new Error(`account "${ownerName}" not found - run \`pnpm seed\` first`);
    }
    return rows[0];
  } finally {
    await client.end();
  }
}

export async function readBalance(client: Client, accountId: number): Promise<number> {
  const { rows } = await client.query<{ balance_cents: number }>(
    "SELECT balance_cents FROM accounts WHERE id = $1",
    [accountId],
  );
  if (!rows[0]) {
    throw new Error(`account id ${accountId} not found`);
  }
  return rows[0].balance_cents;
}

export type RowLockClause = "FOR UPDATE" | "FOR UPDATE NOWAIT" | "FOR SHARE" | "FOR KEY SHARE" | "FOR NO KEY UPDATE";

/**
 * `FOR NO KEY UPDATE` is not valid on a `SELECT` (only `FOR UPDATE`,
 * `FOR NO KEY UPDATE` is a lock *strength* a plain `UPDATE` chooses
 * internally, not a `SELECT` locking clause an application can request
 * directly) - it is included in the union above purely as a label used when
 * describing which strength a plain `UPDATE` implicitly took, never passed
 * to `readBalanceWithLock`.
 */
export async function readBalanceWithLock(
  client: Client,
  accountId: number,
  clause: Extract<RowLockClause, "FOR UPDATE" | "FOR UPDATE NOWAIT" | "FOR SHARE" | "FOR KEY SHARE">,
): Promise<number> {
  const { rows } = await client.query<{ balance_cents: number }>(
    `SELECT balance_cents FROM accounts WHERE id = $1 ${clause}`,
    [accountId],
  );
  if (!rows[0]) {
    throw new Error(`account id ${accountId} not found`);
  }
  return rows[0].balance_cents;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LockSnapshotRow {
  pid: number;
  locktype: string;
  mode: string;
  granted: boolean;
  relation: string | null;
  state: string | null;
  waitEventType: string | null;
  waitEvent: string | null;
  query: string;
}

/**
 * Adapted from packages/db-utils/sql/show-locks.sql, scoped to a specific set
 * of backend pids (the connections this scenario is driving) instead of
 * "every lock in the cluster except mine". Deliberately does NOT filter by
 * `relation`, because the actual wait a blocked `SELECT ... FOR UPDATE`
 * registers is a `locktype = 'transactionid'` row (waiting for a ShareLock on
 * the blocking transaction's xid) - `relation` is NULL on that row. Filtering
 * by relation would hide the single most important row in the snapshot.
 */
export async function snapshotLocks(observer: Client, pids: number[]): Promise<LockSnapshotRow[]> {
  const { rows } = await observer.query<{
    pid: number;
    locktype: string;
    mode: string;
    granted: boolean;
    relation: string | null;
    state: string | null;
    wait_event_type: string | null;
    wait_event: string | null;
    query: string;
  }>(
    `SELECT
       l.pid,
       l.locktype,
       l.mode,
       l.granted,
       CASE WHEN l.relation IS NOT NULL THEN l.relation::regclass::text ELSE NULL END AS relation,
       a.state,
       a.wait_event_type,
       a.wait_event,
       left(a.query, 160) AS query
     FROM pg_locks l
     JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.pid = ANY($1::int[])
     ORDER BY l.granted, l.pid`,
    [pids],
  );

  return rows.map((r) => ({
    pid: r.pid,
    locktype: r.locktype,
    mode: r.mode,
    granted: r.granted,
    relation: r.relation,
    state: r.state,
    waitEventType: r.wait_event_type,
    waitEvent: r.wait_event,
    query: r.query,
  }));
}

/** Postgres error shape for SQLSTATE-bearing errors raised by `pg`. */
export interface PgError extends Error {
  code?: string;
}

export function isPgError(error: unknown): error is PgError {
  return error instanceof Error && "code" in error;
}
