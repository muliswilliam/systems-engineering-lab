import type { PoolClient } from "pg";

/**
 * The exact two buggy queries this lab replays, byte-for-byte identical,
 * against BOTH the naive (no RLS) table state (scenario:naive-leak) and the
 * RLS-protected table state (scenario:rls-fix) - see README "Fix it" for
 * why replaying the IDENTICAL query, not a corrected one, is the actual
 * proof RLS matters.
 */

/**
 * Bug #1: the forgotten `WHERE tenant_id = ?` clause. The single most
 * common real cause of a cross-tenant leak - an admin/debug endpoint, a
 * background digest job, or a newly-added search endpoint that queries the
 * shared table without remembering the tenant filter every other endpoint
 * has. `client` is expected to already be an `app`-role connection with
 * `app.current_tenant_id` set to the CALLING tenant's id (see
 * src/db/roles.ts's `withTenantSession`) - the query itself never
 * references that value, which is exactly the bug.
 */
export async function forgottenWhereClauseQuery(
  client: PoolClient,
): Promise<Array<{ id: number; tenant_id: number; subject: string }>> {
  const { rows } = await client.query<{ id: number; tenant_id: number; subject: string }>(
    "SELECT id, tenant_id, subject FROM support_tickets",
  );
  return rows;
}

/**
 * Bug #2: the WHERE clause is present, but the tenant id plugged into it is
 * WRONG - e.g. resolved from a stale cache entry, a JWT claim that was
 * never re-validated against the current request's actual tenant, or (as
 * modeled here) an off-by-one/mixed-up variable in the handler. This is
 * more insidious than bug #1: a normal-looking, filtered query still leaks
 * data, just a specific OTHER tenant's rows instead of everyone's.
 */
export async function wrongTenantIdQuery(
  client: PoolClient,
  wrongTenantId: number,
): Promise<Array<{ id: number; tenant_id: number; subject: string }>> {
  const { rows } = await client.query<{ id: number; tenant_id: number; subject: string }>(
    "SELECT id, tenant_id, subject FROM support_tickets WHERE tenant_id = $1",
    [wrongTenantId],
  );
  return rows;
}
