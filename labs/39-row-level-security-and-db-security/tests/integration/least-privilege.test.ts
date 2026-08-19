import { afterAll, describe, expect, it } from "vitest";
import { poolFor, withTenantSession, closeAllRolePools } from "../../src/db/roles.js";
import { loadScenarioTenants } from "../../src/scenarios/scenario-lib.js";

describe("least privilege - real captured permission-denied errors per role", () => {
  afterAll(async () => {
    await closeAllRolePools();
  });

  it("readonly role cannot INSERT/UPDATE/DELETE (SELECT only)", async () => {
    const { tenantA } = await loadScenarioTenants();

    await withTenantSession("readonly", tenantA.id, async (client) => {
      await expect(
        client.query("INSERT INTO support_tickets (tenant_id, subject, body) VALUES ($1, 'x', 'x')", [
          tenantA.id,
        ]),
      ).rejects.toMatchObject({ code: "42501" });

      await expect(
        client.query("UPDATE support_tickets SET status = 'closed' WHERE tenant_id = $1", [tenantA.id]),
      ).rejects.toMatchObject({ code: "42501" });

      await expect(
        client.query("DELETE FROM support_tickets WHERE tenant_id = $1", [tenantA.id]),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("app role cannot run DDL (CREATE/ALTER/DROP)", async () => {
    const { tenantA } = await loadScenarioTenants();

    await withTenantSession("app", tenantA.id, async (client) => {
      await expect(client.query("CREATE TABLE app_should_not_create_this (id int)")).rejects.toMatchObject({
        code: "42501",
      });

      await expect(client.query("DROP TABLE support_tickets")).rejects.toMatchObject({ code: "42501" });

      await expect(
        client.query("ALTER TABLE support_tickets ADD COLUMN should_not_exist text"),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("migrator role cannot create or self-escalate roles (no CREATEROLE/SUPERUSER)", async () => {
    const migrator = poolFor("migrator");

    await expect(migrator.query("CREATE ROLE lab39_should_not_exist LOGIN")).rejects.toMatchObject({
      code: "42501",
    });

    await expect(migrator.query("ALTER ROLE lab39_migrator SUPERUSER")).rejects.toMatchObject({
      code: "42501",
    });
  });
});
