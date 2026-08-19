import { Client } from "pg";

/**
 * These scenarios deliberately do NOT use Drizzle or the shared `pg.Pool`
 * from src/db/client.ts. Per CLAUDE.md's "ORM plus SQL" rule, a real
 * concurrent-edit race needs two genuinely independent, explicitly
 * controlled connections issuing interleaved statements - which a query
 * builder does not model well. Two raw `pg.Client` connections make every
 * step of the interleaving explicit and reproducible, the same pattern
 * Lab 06 introduced and Labs 07-08 reused.
 */
export async function connectClient(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

export interface DocumentRow {
  id: number;
  body: string;
  version: number;
  status: string;
}

export async function readDocument(client: Client, documentId: number): Promise<DocumentRow> {
  const { rows } = await client.query<{ id: number; body: string; version: number; status: string }>(
    "SELECT id, body, version, status FROM documents WHERE id = $1",
    [documentId],
  );
  if (!rows[0]) {
    throw new Error(`document id ${documentId} not found`);
  }
  return rows[0];
}

/**
 * Resets one of the fixed "Scenario Document - ..." rows (see
 * src/seed/scenario-documents.ts) back to a known body/version/status before
 * a scenario runs, the same way Lab 07's `resetAccountBalance` did for
 * `accounts` - this makes every scenario (and every test that calls it) safe
 * to re-run without a fresh `pnpm seed`.
 */
export async function resetDocument(
  connectionString: string,
  title: string,
  fields: { body: string; version?: number; status?: string },
): Promise<{ id: number }> {
  const client = await connectClient(connectionString);
  try {
    const version = fields.version ?? 1;
    const status = fields.status ?? "draft";
    const { rows } = await client.query<{ id: number }>(
      "UPDATE documents SET body = $1, version = $2, status = $3, updated_at = now() WHERE title = $4 RETURNING id",
      [fields.body, version, status, title],
    );
    if (!rows[0]) {
      throw new Error(`document "${title}" not found - run \`pnpm seed\` first`);
    }
    return rows[0];
  } finally {
    await client.end();
  }
}
