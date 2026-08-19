import { Client } from "pg";

/**
 * These scenarios deliberately do NOT use Drizzle or the shared `pg.Pool`
 * from src/db/client.ts. Per CLAUDE.md's "ORM plus SQL" rule, isolation-level
 * experiments need two (or three) genuinely independent, explicitly
 * controlled connections/transactions - `BEGIN`, `SET TRANSACTION ISOLATION
 * LEVEL ...`, an interleaved sequence of statements, then `COMMIT` - which a
 * query builder does not model well. Raw `pg.Client` connections make every
 * step of the interleaving explicit and reproducible. This mirrors Lab 07's
 * `src/scenarios/support.ts` pattern exactly, but is a fresh copy owned by
 * this lab - labs do not import each other's source.
 */
export type IsolationLevel = "READ UNCOMMITTED" | "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

/** Postgres's SQLSTATE for "could not serialize access due to concurrent update". */
export const SERIALIZATION_FAILURE_SQLSTATE = "40001";

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

export async function resetAccountBalance(
  connectionString: string,
  accountName: string,
  balanceCents: number,
): Promise<{ id: number }> {
  const client = await connectClient(connectionString);
  try {
    const { rows } = await client.query<{ id: number }>(
      "UPDATE accounts SET balance_cents = $1 WHERE name = $2 RETURNING id",
      [balanceCents, accountName],
    );
    if (!rows[0]) {
      throw new Error(`account "${accountName}" not found - run \`pnpm seed\` first`);
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

/**
 * Resets the two named on-call staff rows to a known baseline: `first` is
 * on call, `second` is on call too - i.e. the invariant "at least one is on
 * call" starts out doubly satisfied, which is what makes the write-skew
 * scenario's outcome ("both go off-call") an actual invariant violation
 * rather than an unsurprising single point of failure.
 */
export async function resetOnCallStaff(
  connectionString: string,
  names: readonly [string, string],
): Promise<{ ids: [number, number] }> {
  const client = await connectClient(connectionString);
  try {
    const ids: number[] = [];
    for (const name of names) {
      const { rows } = await client.query<{ id: number }>(
        "UPDATE on_call_staff SET is_on_call = true WHERE name = $1 RETURNING id",
        [name],
      );
      if (!rows[0]) {
        throw new Error(`on-call staff "${name}" not found - run \`pnpm seed\` first`);
      }
      ids.push(rows[0].id);
    }
    return { ids: [ids[0]!, ids[1]!] };
  } finally {
    await client.end();
  }
}

export async function countOnCall(client: Client, staffIds: readonly number[]): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    "SELECT count(*)::int AS count FROM on_call_staff WHERE id = ANY($1) AND is_on_call = true",
    [staffIds],
  );
  return Number(rows[0]!.count);
}

export async function readIsOnCall(client: Client, staffId: number): Promise<boolean> {
  const { rows } = await client.query<{ is_on_call: boolean }>(
    "SELECT is_on_call FROM on_call_staff WHERE id = $1",
    [staffId],
  );
  if (!rows[0]) {
    throw new Error(`on-call staff id ${staffId} not found`);
  }
  return rows[0].is_on_call;
}

/** Extracts the SQLSTATE code from a `pg` driver error, if present. */
export function getPgErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when `error` is a Postgres serialization failure (SQLSTATE 40001). */
export function isSerializationFailure(error: unknown): boolean {
  return getPgErrorCode(error) === SERIALIZATION_FAILURE_SQLSTATE;
}
