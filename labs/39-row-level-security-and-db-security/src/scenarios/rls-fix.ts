import { createLogger } from "@labs/logging";
import { poolFor, withTenantSession, closeAllRolePools } from "../db/roles.js";
import { loadScenarioTenants } from "./scenario-lib.js";
import { forgottenWhereClauseQuery, wrongTenantIdQuery } from "./buggy-queries.js";

const log = createLogger("lab39:scenario:rls-fix");

/**
 * THE FIX (README "Fix it"): replays the IDENTICAL two buggy queries from
 * scenario:naive-leak (byte-for-byte the same functions, from
 * buggy-queries.ts) against the SAME table, as the SAME `app` role - the
 * only difference is that Row-Level Security is enabled (this script
 * assumes the table is in its normal post-migration state; run
 * `pnpm db:migrate` if you haven't, or re-run this after scenario:naive-leak,
 * which always re-enables RLS before exiting).
 *
 * This is the concrete, measured proof this lab exists to produce: the
 * database, not the application code, is what stopped the leak. Neither
 * buggy query below was fixed - they are the exact same SQL text as
 * naive-leak.ts.
 */
async function main() {
  const { tenantA, tenantB } = await loadScenarioTenants();
  const migrator = poolFor("migrator");

  const { rows: rlsState } = await migrator.query<{ relrowsecurity: boolean }>(
    "SELECT relrowsecurity FROM pg_class WHERE relname = 'support_tickets'",
  );
  if (!rlsState[0]?.relrowsecurity) {
    throw new Error(
      "support_tickets does not have Row-Level Security enabled - run `pnpm db:migrate` (or re-run scenario:naive-leak, which restores it) before this scenario",
    );
  }

  // --- Bug #1 replayed: forgotten WHERE clause ---
  await withTenantSession("app", tenantA.id, async (client) => {
    const rows = await forgottenWhereClauseQuery(client);
    const otherTenantRows = rows.filter((r) => r.tenant_id !== tenantA.id);

    log.info(
      {
        requestingTenant: tenantA.name,
        sessionTenantId: tenantA.id,
        totalRowsReturned: rows.length,
        distinctTenantIdsReturned: new Set(rows.map((r) => r.tenant_id)).size,
        rowsBelongingToOtherTenants: otherTenantRows.length,
      },
      "bug #1 replayed under RLS: the exact same tenant-blind query now returns ONLY the calling tenant's own rows",
    );

    if (otherTenantRows.length !== 0) {
      throw new Error(
        `RLS did not block the leak: ${otherTenantRows.length} rows from other tenants were returned`,
      );
    }
  });

  // --- Bug #2 replayed: WHERE clause present, wrong tenant id ---
  await withTenantSession("app", tenantA.id, async (client) => {
    const rows = await wrongTenantIdQuery(client, tenantB.id);
    log.info(
      {
        requestingTenant: tenantA.name,
        sessionTenantId: tenantA.id,
        queriedTenantId: tenantB.id,
        queriedTenantName: tenantB.name,
        rowsReturned: rows.length,
      },
      "bug #2 replayed under RLS: the app's own WHERE clause asked for tenant B, but the session's RLS predicate is ANDed onto it - zero rows, not tenant B's data",
    );

    if (rows.length !== 0) {
      throw new Error(`RLS did not block the leak: ${rows.length} rows from tenant B were returned`);
    }
  });

  // --- No tenant context set at all: fails CLOSED, not open ---
  await withTenantSession("app", null, async (client) => {
    const rows = await forgottenWhereClauseQuery(client);
    log.info(
      { rowsReturned: rows.length },
      "no app.current_tenant_id set at all: RLS's default-deny means zero rows, not every tenant's rows",
    );
    if (rows.length !== 0) {
      throw new Error(`Expected 0 rows with no tenant context set, got ${rows.length}`);
    }
  });

  await closeAllRolePools();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "scenario:rls-fix failed");
  process.exit(1);
});
