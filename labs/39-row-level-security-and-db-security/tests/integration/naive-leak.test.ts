import { afterAll, afterEach, describe, expect, it } from "vitest";
import { poolFor, withTenantSession, closeAllRolePools } from "../../src/db/roles.js";
import { loadScenarioTenants } from "../../src/scenarios/scenario-lib.js";
import { forgottenWhereClauseQuery, wrongTenantIdQuery } from "../../src/scenarios/buggy-queries.js";

/**
 * This file is the ONLY one in this lab that turns Row-Level Security OFF
 * (as the owning migrator role) to reproduce the pre-fix naive state - see
 * vitest.config.ts's `fileParallelism: false` for why that requires test
 * files to run sequentially against this shared database. RLS is always
 * restored in `afterEach`, even if an assertion throws, so no other test
 * file - regardless of Vitest's file-discovery order - ever observes the
 * table with RLS disabled.
 */
describe("naive leak (RLS disabled) - the failure this lab exists to fix", () => {
  afterEach(async () => {
    await poolFor("migrator").query("ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY");
  });

  afterAll(async () => {
    await closeAllRolePools();
  });

  it("a tenant-blind query leaks every tenant's rows once RLS is off", async () => {
    const { tenantA } = await loadScenarioTenants();
    await poolFor("migrator").query("ALTER TABLE support_tickets DISABLE ROW LEVEL SECURITY");

    const rows = await withTenantSession("app", tenantA.id, (client) => forgottenWhereClauseQuery(client));

    const distinctTenants = new Set(rows.map((r) => r.tenant_id));
    const otherTenantRows = rows.filter((r) => r.tenant_id !== tenantA.id);

    // The real invariant this test asserts: with RLS off, the naive query
    // leaks MORE than one tenant's worth of rows. It intentionally does not
    // assert an exact row count (that depends on --size/--seed at seed
    // time) - only the invariant "more than one tenant's data came back".
    expect(distinctTenants.size).toBeGreaterThan(1);
    expect(otherTenantRows.length).toBeGreaterThan(0);
  });

  it("a wrong-tenant-id query returns another tenant's real rows once RLS is off", async () => {
    const { tenantA, tenantB } = await loadScenarioTenants();
    await poolFor("migrator").query("ALTER TABLE support_tickets DISABLE ROW LEVEL SECURITY");

    const rows = await withTenantSession("app", tenantA.id, (client) =>
      wrongTenantIdQuery(client, tenantB.id),
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenant_id === tenantB.id)).toBe(true);
  });
});
