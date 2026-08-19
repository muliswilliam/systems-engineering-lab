import "dotenv/config";
import { Pool, type PoolClient } from "pg";
import { createPool } from "@labs/db-utils";

/**
 * The four real Postgres roles this lab creates (sql/000-bootstrap-roles.sql)
 * and connects as. Each name below is BOTH the actual Postgres role name and
 * the env var suffix used to look up its connection string - see
 * .env.example.
 */
export const ROLE_NAMES = ["admin", "migrator", "app", "readonly"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

function envVarFor(role: RoleName): string {
  return `DATABASE_URL_${role.toUpperCase()}`;
}

function connectionStringFor(role: RoleName): string {
  const value = process.env[envVarFor(role)];
  if (!value) {
    throw new Error(`${envVarFor(role)} is not set - copy .env.example to .env first`);
  }
  return value;
}

const pools = new Map<RoleName, Pool>();

/** Lazily creates (and caches) one Pool per role, one process-wide. */
export function poolFor(role: RoleName): Pool {
  let pool = pools.get(role);
  if (!pool) {
    pool = createPool({ connectionString: connectionStringFor(role) });
    pools.set(role, pool);
  }
  return pool;
}

export async function closeAllRolePools(): Promise<void> {
  await Promise.all([...pools.values()].map((pool) => pool.end()));
  pools.clear();
}

/**
 * The standard real-world connection-pooled multi-tenant RLS pattern: check
 * out ONE client, tell Postgres which tenant this session/connection speaks
 * for via `set_config('app.current_tenant_id', ..., false)` (session-level,
 * survives until changed or the connection is released), run the caller's
 * queries, then ALWAYS clear the setting back to NULL before releasing the
 * client back to the pool.
 *
 * That final reset is not decorative - it is the real operational gotcha of
 * this pattern under connection pooling (PgBouncer transaction pooling, or
 * even just `pg.Pool` reusing sockets, as here): if a connection is handed
 * back to the pool with tenant A's session var still set, and the NEXT
 * caller sets tenant B's context onto that same PHYSICAL connection without
 * anything actually resetting it between, both orderings still leave the
 * right final value in place, but only because `set_config` overwrites
 * unconditionally - the bug this guards against is a code path that reads
 * `current_tenant_id()` for logging/auditing BEFORE calling this helper
 * again, or a connection that errors out mid-transaction and gets released
 * without this `finally` running. See README "Tradeoffs" for the fuller
 * discussion (this is the same class of session-state caveat Lab 23 raises
 * for PgBouncer, applied to an RLS session variable instead of a prepared
 * statement).
 */
export async function withTenantSession<T>(
  role: RoleName,
  tenantId: number | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await poolFor(role).connect();
  try {
    // set_config's new_value is always text; an empty string (rather than
    // SQL NULL) means "no tenant" - current_tenant_id() (see migration
    // 0001) treats '' the same as unset via `nullif(..., '')`, so an
    // unauthenticated/no-tenant session fails CLOSED (sees zero rows)
    // instead of erroring.
    await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [
      tenantId === null ? "" : String(tenantId),
    ]);
    return await fn(client);
  } finally {
    await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [""]);
    client.release();
  }
}
