import { Client, Pool } from "pg";

/**
 * These scenarios deliberately do NOT use Drizzle or the shared `pg.Pool`
 * from src/db/client.ts for the actual transfer legs. Per CLAUDE.md's "ORM
 * plus SQL" rule, a real deadlock needs two genuinely independent,
 * explicitly controlled connections/transactions - `BEGIN`, two separate
 * `SELECT ... FOR UPDATE` statements in a deliberate order, then whatever
 * Postgres itself decides to do - which a query builder does not model well.
 * Raw `pg.Client` connections make every step of the interleaving explicit
 * and (via `processID`) identifiable in `pg_locks`/`pg_stat_activity`, the
 * same approach Lab 06/10/13 use for their own two/three-connection
 * scenarios.
 */

export interface ConnectedClient {
  client: Client;
  /** The backend PID Postgres assigned this connection - used to scope
   * pg_locks/pg_stat_activity snapshots to exactly the connections this
   * scenario is driving. */
  pid: number;
}

export async function connectClient(connectionString: string): Promise<ConnectedClient> {
  const client = new Client({ connectionString });
  await client.connect();
  const pid = (client as unknown as { processID: number }).processID;
  return { client, pid };
}

export async function getAccountIdByName(connectionString: string, ownerName: string): Promise<number> {
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

export async function resetAccountBalanceByName(
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

export async function resetAccountBalancesById(pool: Pool, ids: number[], balanceCents: number): Promise<void> {
  await pool.query("UPDATE accounts SET balance_cents = $1 WHERE id = ANY($2::bigint[])", [balanceCents, ids]);
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Postgres error shape for SQLSTATE-bearing errors raised by `pg` -
 * `DatabaseError` copies `detail`/`hint`/`code` straight off the wire
 * protocol's ErrorResponse fields, so these are Postgres's OWN words, not
 * anything this lab synthesizes. */
export interface PgError extends Error {
  code?: string;
  detail?: string;
  hint?: string;
}

export function isPgError(error: unknown): error is PgError {
  return error instanceof Error && "code" in error;
}

export const DEADLOCK_DETECTED_SQLSTATE = "40P01";
