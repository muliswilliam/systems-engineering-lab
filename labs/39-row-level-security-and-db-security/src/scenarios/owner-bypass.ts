import { createLogger } from "@labs/logging";
import { poolFor, withTenantSession, closeAllRolePools } from "../db/roles.js";
import { firstRow } from "./scenario-lib.js";

const log = createLogger("lab39:scenario:owner-bypass");

/**
 * THE GOTCHA (README "Fix it" / "Production notes"): Row-Level Security
 * policies do NOT apply to the table's OWNER, and NEVER apply to a
 * superuser or any role with the BYPASSRLS attribute - REGARDLESS of what
 * the policy says, and regardless of whether a session ever sets
 * app.current_tenant_id at all. This script demonstrates both bypass paths
 * as REAL connections against the REAL RLS-protected table, contrasted
 * with the `app` role (not the owner, not BYPASSRLS), which is actually
 * enforced.
 */
async function main() {
  const { rows: roleInfo } = await poolFor("admin").query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>(
    "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('lab39_admin', 'lab39_migrator', 'lab39_app', 'lab39_readonly') ORDER BY rolname",
  );
  const { rows: ownerInfo } = await poolFor("admin").query<{ tablename: string; tableowner: string }>(
    "SELECT tablename, tableowner FROM pg_tables WHERE tablename = 'support_tickets'",
  );
  log.info({ roles: roleInfo, tableOwner: ownerInfo[0]?.tableowner }, "role attributes and table ownership");

  // No tenant context set for ANY of the three connections below - this
  // isolates the bypass itself from "did the session happen to set a
  // matching tenant id", the same fail-closed baseline scenario:rls-fix's
  // last check established for the `app` role.

  const migratorTotals = await withTenantSession("migrator", null, async (client) => {
    const { rows } = await client.query<{ total: string; distinct_tenants: string }>(
      "SELECT count(*) AS total, count(DISTINCT tenant_id) AS distinct_tenants FROM support_tickets",
    );
    return firstRow(rows);
  });
  log.warn(
    { role: "lab39_migrator (table owner, NOT superuser, NOT BYPASSRLS)", ...migratorTotals },
    "OWNER BYPASS: the owning role sees every tenant's rows even with RLS enabled and no FORCE ROW LEVEL SECURITY set, and even with no tenant session context",
  );

  const adminTotals = await withTenantSession("admin", null, async (client) => {
    const { rows } = await client.query<{ total: string; distinct_tenants: string }>(
      "SELECT count(*) AS total, count(DISTINCT tenant_id) AS distinct_tenants FROM support_tickets",
    );
    return firstRow(rows);
  });
  log.warn(
    { role: "lab39_admin (superuser)", ...adminTotals },
    "SUPERUSER BYPASS: a superuser connection ignores RLS unconditionally - this would be true even if FORCE ROW LEVEL SECURITY were set on the table",
  );

  const appTotals = await withTenantSession("app", null, async (client) => {
    const { rows } = await client.query<{ total: string; distinct_tenants: string }>(
      "SELECT count(*) AS total, count(DISTINCT tenant_id) AS distinct_tenants FROM support_tickets",
    );
    return firstRow(rows);
  });
  log.info(
    { role: "lab39_app (not owner, not BYPASSRLS)", ...appTotals },
    "ENFORCED: the app role, with no tenant context set, sees zero rows - the SAME identical query the owner/superuser just ran against every tenant's data",
  );

  if (Number(appTotals.total) !== 0) {
    throw new Error(`Expected the app role to see 0 rows with no tenant context, saw ${appTotals.total}`);
  }
  if (Number(migratorTotals.total) === 0 || Number(adminTotals.total) === 0) {
    throw new Error("Expected the owner/superuser connections to bypass RLS and see every row");
  }

  log.info(
    "why this matters: who OWNS these tables in a real deployment should be a narrow, audited migration role - never the day-to-day application role, and never a role humans log in as interactively - because ownership alone is a silent, total RLS bypass with no separate flag to notice in application code.",
  );

  await closeAllRolePools();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "scenario:owner-bypass failed");
  process.exit(1);
});
