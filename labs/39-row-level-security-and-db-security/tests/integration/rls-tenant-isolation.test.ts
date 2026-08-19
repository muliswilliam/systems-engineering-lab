import { afterAll, describe, expect, it } from "vitest";
import { withTenantSession, closeAllRolePools } from "../../src/db/roles.js";
import { loadScenarioTenants } from "../../src/scenarios/scenario-lib.js";
import { forgottenWhereClauseQuery, wrongTenantIdQuery } from "../../src/scenarios/buggy-queries.js";

describe("RLS tenant isolation (support_tickets)", () => {
  afterAll(async () => {
    await closeAllRolePools();
  });

  it("blocks a tenant-blind query (forgotten WHERE clause) even though the app role never filters by tenant", async () => {
    const { tenantA } = await loadScenarioTenants();

    const rows = await withTenantSession("app", tenantA.id, (client) => forgottenWhereClauseQuery(client));

    expect(rows.length).toBeGreaterThan(0);
    const otherTenantRows = rows.filter((r) => r.tenant_id !== tenantA.id);
    expect(otherTenantRows).toHaveLength(0);
  });

  it("blocks a query whose own WHERE clause names the WRONG tenant id", async () => {
    const { tenantA, tenantB } = await loadScenarioTenants();

    const rows = await withTenantSession("app", tenantA.id, (client) =>
      wrongTenantIdQuery(client, tenantB.id),
    );

    // The app's WHERE clause explicitly asked for tenant B's rows - RLS
    // ANDs its own predicate (tenant_id = session tenant, i.e. tenant A)
    // onto that, so the intersection is empty. Not tenant B's data leaking,
    // and not an error - zero rows.
    expect(rows).toHaveLength(0);
  });

  it("fails CLOSED (zero rows), not open, when no tenant session is set at all", async () => {
    const rows = await withTenantSession("app", null, (client) => forgottenWhereClauseQuery(client));
    expect(rows).toHaveLength(0);
  });

  it("still lets a correctly-filtered query see exactly its own tenant's rows", async () => {
    const { tenantA } = await loadScenarioTenants();

    const rows = await withTenantSession("app", tenantA.id, async (client) => {
      const { rows } = await client.query<{ id: number; tenant_id: number }>(
        "SELECT id, tenant_id FROM support_tickets WHERE tenant_id = $1",
        [tenantA.id],
      );
      return rows;
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenant_id === tenantA.id)).toBe(true);
  });

  it("blocks writing a row that claims to belong to a different tenant than the session's", async () => {
    const { tenantA, tenantB } = await loadScenarioTenants();

    await expect(
      withTenantSession("app", tenantA.id, (client) =>
        client.query("INSERT INTO support_tickets (tenant_id, subject, body) VALUES ($1, 'x', 'x')", [
          tenantB.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
