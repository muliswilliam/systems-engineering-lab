import { Client } from "pg";

/**
 * These scenarios deliberately do NOT use Drizzle or the shared `pg.Pool`
 * from src/db/client.ts. Per CLAUDE.md's "ORM plus SQL" rule, isolation-level
 * experiments need genuinely independent, explicitly-controlled connections
 * and transactions - `BEGIN`, `SET TRANSACTION ISOLATION LEVEL ...`, an
 * interleaved sequence of statements, then `COMMIT` or a caught serialization
 * failure - which a query builder does not model well. Raw `pg.Client`
 * connections make every step of the interleaving explicit and reproducible,
 * following the same pattern Lab 07 established.
 */
export type IsolationLevel = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

/** Postgres's SQLSTATE for "could not serialize access due to read/write
 * dependencies among transactions" - the error Serializable Snapshot
 * Isolation (SSI) raises when it detects a dangerous rw-conflict cycle. */
export const SERIALIZATION_FAILURE_SQLSTATE = "40001";

interface PgError {
  code?: string;
  message?: string;
}

export function isSerializationFailure(error: unknown): error is PgError {
  return typeof error === "object" && error !== null && (error as PgError).code === SERIALIZATION_FAILURE_SQLSTATE;
}

export async function connectClient(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

/**
 * Starts a transaction and requests the given isolation level, then reads
 * back what Postgres actually recorded via `SHOW transaction_isolation`.
 */
export async function beginWithIsolation(
  client: Client,
  level: IsolationLevel,
): Promise<{ requested: IsolationLevel; actual: string }> {
  await client.query("BEGIN");
  await client.query(`SET TRANSACTION ISOLATION LEVEL ${level}`);
  const { rows } = await client.query<{ transaction_isolation: string }>("SHOW transaction_isolation");
  return { requested: level, actual: rows[0]!.transaction_isolation };
}

/** Resets every named staff member on a team to `is_on_call = true` (the
 * "fully staffed" baseline every scenario starts from) and returns a
 * name -> id map, so scenarios and tests never hardcode ids. */
export async function resetTeamOnCall(
  connectionString: string,
  team: string,
  names: readonly string[],
): Promise<Record<string, number>> {
  const client = await connectClient(connectionString);
  try {
    const { rows } = await client.query<{ id: number; name: string }>(
      "UPDATE on_call_staff SET is_on_call = true WHERE team = $1 AND name = ANY($2) RETURNING id, name",
      [team, names],
    );
    if (rows.length !== names.length) {
      throw new Error(
        `expected to reset ${names.length} staff on team "${team}" but only found ${rows.length} - run \`pnpm seed\` first`,
      );
    }
    const byName: Record<string, number> = {};
    for (const row of rows) byName[row.name] = row.id;
    return byName;
  } finally {
    await client.end();
  }
}

/** Counts how many OTHER staff on the same team are currently on call, as
 * visible to this transaction's snapshot - i.e. "is it safe for me to go
 * off call?" This is the read half of the write-skew anomaly: two
 * transactions can both run this query, both see the other still on call,
 * and both independently conclude "yes, safe". */
export async function countOthersOnCall(client: Client, team: string, excludeStaffId: number): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    "SELECT count(*) FROM on_call_staff WHERE team = $1 AND is_on_call = true AND id != $2",
    [team, excludeStaffId],
  );
  return Number(rows[0]!.count);
}

/** Independent, short-lived-connection read of the current on-call count for
 * a team, used AFTER a scenario's transactions have resolved to check
 * whether the "at least one on call" invariant actually held. */
export async function countOnCall(connectionString: string, team: string): Promise<number> {
  const client = await connectClient(connectionString);
  try {
    const { rows } = await client.query<{ count: string }>(
      "SELECT count(*) FROM on_call_staff WHERE team = $1 AND is_on_call = true",
      [team],
    );
    return Number(rows[0]!.count);
  } finally {
    await client.end();
  }
}

export async function setOffCall(client: Client, staffId: number): Promise<void> {
  await client.query("UPDATE on_call_staff SET is_on_call = false WHERE id = $1", [staffId]);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter, capped at `maxMs`. `attempt` is
 * 1-based (the delay taken before the *next* retry, i.e. after attempt N
 * failed with a serialization error). */
export function randomizedBackoffMs(attempt: number, baseMs = 25, maxMs = 300): number {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.random() * cap;
}
