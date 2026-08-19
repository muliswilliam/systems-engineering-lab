import { afterAll, describe, expect, it } from "vitest";
import { withTenantSession, closeAllRolePools } from "../../src/db/roles.js";

describe("owner/superuser RLS bypass - the real, common misconfiguration", () => {
  afterAll(async () => {
    await closeAllRolePools();
  });

  it("the table-owning migrator role bypasses RLS even with no tenant session set", async () => {
    const { total, distinctTenants } = await withTenantSession("migrator", null, async (client) => {
      const { rows } = await client.query<{ total: string; distinct_tenants: string }>(
        "SELECT count(*) AS total, count(DISTINCT tenant_id) AS distinct_tenants FROM support_tickets",
      );
      return { total: Number(rows[0]?.total ?? 0), distinctTenants: Number(rows[0]?.distinct_tenants ?? 0) };
    });

    expect(total).toBeGreaterThan(0);
    expect(distinctTenants).toBeGreaterThan(1);
  });

  it("a superuser connection bypasses RLS even with no tenant session set", async () => {
    const { total, distinctTenants } = await withTenantSession("admin", null, async (client) => {
      const { rows } = await client.query<{ total: string; distinct_tenants: string }>(
        "SELECT count(*) AS total, count(DISTINCT tenant_id) AS distinct_tenants FROM support_tickets",
      );
      return { total: Number(rows[0]?.total ?? 0), distinctTenants: Number(rows[0]?.distinct_tenants ?? 0) };
    });

    expect(total).toBeGreaterThan(0);
    expect(distinctTenants).toBeGreaterThan(1);
  });

  it("the non-owner app role, by contrast, is actually enforced (0 rows with no tenant session)", async () => {
    const total = await withTenantSession("app", null, async (client) => {
      const { rows } = await client.query<{ total: string }>(
        "SELECT count(*) AS total FROM support_tickets",
      );
      return Number(rows[0]?.total ?? 0);
    });

    expect(total).toBe(0);
  });
});
