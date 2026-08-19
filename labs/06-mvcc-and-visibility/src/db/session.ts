import "dotenv/config";
import { Client } from "pg";

/**
 * This lab is fundamentally about two independent database *sessions*
 * (backends), not just two logical queries against one shared pool. A
 * Drizzle query builder on top of a shared `pg.Pool` (the pattern every
 * other lab so far uses) can silently borrow whichever connection is free,
 * which makes it impossible to reliably keep one transaction open on
 * "connection A" while doing real work on "connection B". `openSession`
 * hands back a single dedicated `pg.Client` - a raw, unpooled connection -
 * so scenario scripts and tests can drive two real Postgres backends with
 * explicit, deliberately-ordered control flow.
 *
 * Deliberately raw `pg`, not Drizzle: per CLAUDE.md, transaction/visibility
 * behavior should be explicit, and BEGIN/COMMIT/system-column selects read
 * more clearly as SQL than as query-builder calls here.
 */
export interface Session {
  /** Postgres backend PID for this connection (`pg_backend_pid()`) - useful for correlating with pg_stat_activity. */
  readonly pid: number;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

export async function openSession(connectionString: string): Promise<Session> {
  const client = new Client({ connectionString });
  await client.connect();
  const pidResult = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const pid = pidResult.rows[0]!.pid;

  return {
    pid,
    async query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) {
      const result = await client.query<T>(text, params);
      return result.rows;
    },
    async begin() {
      await client.query("BEGIN");
    },
    async commit() {
      await client.query("COMMIT");
    },
    async rollback() {
      await client.query("ROLLBACK");
    },
    async close() {
      await client.end();
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
