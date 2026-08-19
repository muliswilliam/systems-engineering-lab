import { createLogger } from "@labs/logging";
import { poolFor, withTenantSession, closeAllRolePools } from "../db/roles.js";
import { loadScenarioTenants, describePgError } from "./scenario-lib.js";

const log = createLogger("lab39:scenario:least-privilege");

const EXPECTED_CODE = "42501"; // insufficient_privilege

/**
 * LEAST PRIVILEGE (README "Fix it"): every one of these is a REAL operation
 * attempted against a REAL Postgres connection as the role named, expected
 * to fail with a REAL captured SQLSTATE 42501 (insufficient_privilege) -
 * none of these are simulated or merely documented as "should" fail.
 */
async function expectDenied(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    log.error({ label }, "UNEXPECTED: operation succeeded but should have been denied");
    throw new Error(`${label}: expected a permission-denied error, but the operation succeeded`);
  } catch (error) {
    const { code, message } = describePgError(error);
    if (code !== EXPECTED_CODE) {
      throw error;
    }
    log.info({ label, sqlstate: code, message }, "real captured permission-denied error");
  }
}

async function main() {
  const { tenantA, tenantB } = await loadScenarioTenants();

  // --- readonly role: SELECT only, no writes ---
  await withTenantSession("readonly", tenantA.id, async (client) => {
    await expectDenied("readonly INSERT", () =>
      client.query("INSERT INTO support_tickets (tenant_id, subject, body) VALUES ($1, 'x', 'x')", [
        tenantA.id,
      ]),
    );
    await expectDenied("readonly UPDATE", () =>
      client.query("UPDATE support_tickets SET status = 'closed' WHERE tenant_id = $1", [tenantA.id]),
    );
    await expectDenied("readonly DELETE", () =>
      client.query("DELETE FROM support_tickets WHERE tenant_id = $1", [tenantA.id]),
    );
  });

  // --- app role: read/write on data, but no DDL and no ownership rights ---
  await withTenantSession("app", tenantA.id, async (client) => {
    await expectDenied("app CREATE TABLE", () =>
      client.query("CREATE TABLE app_should_not_create_this (id int)"),
    );
    await expectDenied("app DROP TABLE", () => client.query("DROP TABLE support_tickets"));
    await expectDenied("app ALTER TABLE (add column)", () =>
      client.query("ALTER TABLE support_tickets ADD COLUMN should_not_exist text"),
    );

    // A write-path RLS violation, not just a grant-level denial: app HAS
    // INSERT privilege on support_tickets, but the session is scoped to
    // tenant A (app.current_tenant_id = tenantA.id) - inserting a row
    // claiming to belong to tenant B violates the tenant_isolation
    // policy's WITH CHECK clause, which is also surfaced as SQLSTATE
    // 42501 ("new row violates row-level security policy").
    await expectDenied("app INSERT cross-tenant row (RLS WITH CHECK)", () =>
      client.query("INSERT INTO support_tickets (tenant_id, subject, body) VALUES ($1, 'x', 'x')", [
        tenantB.id,
      ]),
    );
  });

  // --- migrator role: DDL rights, but not superuser and cannot self-escalate ---
  const migrator = poolFor("migrator");
  await expectDenied("migrator CREATE ROLE (no CREATEROLE)", () =>
    migrator.query("CREATE ROLE lab39_should_not_exist LOGIN"),
  );
  await expectDenied("migrator ALTER lab39_migrator SUPERUSER (no self-escalation)", () =>
    migrator.query("ALTER ROLE lab39_migrator SUPERUSER"),
  );

  log.info("all least-privilege boundaries held: every out-of-scope operation was denied");
  await closeAllRolePools();
}

main().catch((error: unknown) => {
  log.error({ err: error }, "scenario:least-privilege failed");
  process.exit(1);
});
