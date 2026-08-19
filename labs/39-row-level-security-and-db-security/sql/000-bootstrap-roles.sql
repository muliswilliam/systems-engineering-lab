-- Runs exactly once, automatically, the first time the Postgres data
-- directory is initialized (docker-entrypoint-initdb.d convention), as the
-- POSTGRES_USER superuser configured in docker-compose.yml
-- (lab39_admin/lab39_admin_pw by default). This is the ONLY point in this
-- lab where a superuser creates other roles - see README "Setup".
--
-- These passwords are fine for a lab that only ever binds to
-- 127.0.0.1:5439. Never reuse literal passwords like this outside a local
-- Docker Compose lab (see README "Production notes").

CREATE ROLE lab39_migrator LOGIN PASSWORD 'lab39_migrator_pw'
  NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;

CREATE ROLE lab39_app LOGIN PASSWORD 'lab39_app_pw'
  NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;

CREATE ROLE lab39_readonly LOGIN PASSWORD 'lab39_readonly_pw'
  NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;

-- CONNECT is granted to PUBLIC by default on a fresh database, but this
-- lab is explicit about it rather than relying on that default (a real
-- hardened deployment typically REVOKEs CONNECT from PUBLIC first). Using a
-- DO block + format(%I) so this script works regardless of what
-- POSTGRES_DB is actually named.
DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO lab39_migrator, lab39_app, lab39_readonly',
    current_database()
  );
END
$$;

-- Postgres 15+ no longer grants CREATE on the "public" schema to PUBLIC by
-- default. lab39_migrator is the only role that needs to create objects
-- (tables/functions/policies) there - lab39_app and lab39_readonly only
-- ever need USAGE (to reference objects that already exist), never CREATE.
GRANT CREATE, USAGE ON SCHEMA public TO lab39_migrator;
GRANT USAGE ON SCHEMA public TO lab39_app, lab39_readonly;

-- drizzle-orm's own migrator additionally creates a dedicated "drizzle"
-- schema (to hold its `__drizzle_migrations` bookkeeping table) the first
-- time `pnpm db:migrate` runs - CREATE SCHEMA is a database-level privilege
-- in Postgres, not a schema-level one, so lab39_migrator needs CREATE on
-- the database itself for that one bookkeeping schema, in addition to
-- CREATE on the public schema above.
DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO lab39_migrator', current_database());
END
$$;

-- The migration role owns every table/function/policy it creates (creator
-- = owner, in Postgres). Rather than requiring a human to remember to GRANT
-- privileges to lab39_app/lab39_readonly after every future migration,
-- ALTER DEFAULT PRIVILEGES makes it automatic for anything lab39_migrator
-- creates in schema public from this point forward.
ALTER DEFAULT PRIVILEGES FOR ROLE lab39_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lab39_app;

ALTER DEFAULT PRIVILEGES FOR ROLE lab39_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO lab39_readonly;

ALTER DEFAULT PRIVILEGES FOR ROLE lab39_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO lab39_app, lab39_readonly;
