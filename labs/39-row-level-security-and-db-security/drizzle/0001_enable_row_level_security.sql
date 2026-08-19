-- Hand-authored raw SQL (via `drizzle-kit generate --custom`), not
-- expressible as Drizzle `pgTable()` schema config: ROW LEVEL SECURITY,
-- CREATE POLICY, and GRANT are Postgres-specific DDL with no vocabulary in
-- Drizzle's schema-diffing DSL. Per CLAUDE.md's "ORM plus SQL" principle,
-- this is exactly the kind of statement that should be raw SQL rather than
-- hidden behind an abstraction. Runs as the MIGRATOR role (see
-- src/db/migrate.ts), which OWNS both tables because it created them in
-- migration 0000 - owning them is what allows it to ALTER TABLE ... ENABLE
-- ROW LEVEL SECURITY and CREATE POLICY on them (both owner-or-superuser-only
-- operations).

-- A small helper function centralizes the "read the session's tenant
-- context, treat unset/empty as NULL" logic so every policy below reads
-- identically instead of repeating `nullif(current_setting(...), '')::bigint`
-- verbatim in each USING/WITH CHECK clause. STABLE (not VOLATILE) tells the
-- planner this returns the same value for the whole statement, which
-- matters for how cheaply the planner can fold it into an index condition
-- (see README "Tradeoffs" / scenario:performance).
--
-- current_setting(..., true) (missing_ok=true) returns NULL instead of
-- raising an error when app.current_tenant_id was never set at all in this
-- session - so a connection that forgot to call
-- set_config('app.current_tenant_id', ...) sees ZERO rows (fails CLOSED),
-- not an error and not every tenant's rows.
CREATE FUNCTION current_tenant_id() RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.current_tenant_id', true), '')::bigint
$$;

-- --- tenants ---
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants
  USING (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

-- --- support_tickets ---
ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON support_tickets
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Explicit GRANTs, redundant with sql/000-bootstrap-roles.sql's
-- `ALTER DEFAULT PRIVILEGES ... FOR ROLE lab39_migrator` (which already
-- applies these automatically to every table lab39_migrator creates from
-- here on) - kept explicit anyway, in the migration itself, so a reader of
-- this file sees exactly what each role can do without also having to read
-- the bootstrap script. Belt and suspenders is deliberate here, not
-- accidental duplication.
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, support_tickets TO lab39_app;
GRANT SELECT ON tenants, support_tickets TO lab39_readonly;
GRANT EXECUTE ON FUNCTION current_tenant_id() TO lab39_app, lab39_readonly;

-- Deliberately NOT done here (see README "Break it" / "Production notes"):
--   ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--   ALTER TABLE support_tickets FORCE ROW LEVEL SECURITY;
-- FORCE ROW LEVEL SECURITY would make the policy apply even to the OWNING
-- role (lab39_migrator) - but NEVER to an actual superuser or any role with
-- the BYPASSRLS attribute (lab39_admin has both by default), regardless of
-- FORCE. This lab leaves FORCE off on purpose so scenario:owner-bypass can
-- demonstrate the real, common misconfiguration: RLS policies do not
-- protect data from the role that owns the table unless FORCE is set, and
-- never protect data from a superuser/BYPASSRLS role no matter what.
