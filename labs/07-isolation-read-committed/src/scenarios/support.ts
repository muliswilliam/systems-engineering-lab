import { Client } from "pg";

/**
 * These scenarios deliberately do NOT use Drizzle or the shared `pg.Pool`
 * from src/db/client.ts. Per CLAUDE.md's "ORM plus SQL" rule, isolation-level
 * experiments need two genuinely independent, explicitly-controlled
 * connections/transactions - `BEGIN`, `SET TRANSACTION ISOLATION LEVEL ...`,
 * an interleaved sequence of statements, then `COMMIT` - which a query
 * builder does not model well. Two raw `pg.Client` connections make every
 * step of the interleaving explicit and reproducible.
 */
export type IsolationLevel = "READ UNCOMMITTED" | "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

export async function connectClient(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

/**
 * Starts a transaction and requests the given isolation level, then reads
 * back what Postgres actually recorded via `SHOW transaction_isolation`.
 * The whole point of this lab is that "requested" and "actual" can diverge
 * for READ UNCOMMITTED - see dirty-read-attempt.ts.
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
