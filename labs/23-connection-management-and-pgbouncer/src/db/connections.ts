import "dotenv/config";

/**
 * Connection-string helpers for the three targets every scenario in this lab
 * compares. Kept separate from client.ts's shared Drizzle pool because these
 * scenarios are specifically about *how many* underlying connections get
 * opened and to *what* - each scenario needs full control over creating and
 * tearing down its own raw `pg.Pool`/`pg.Client` instances rather than
 * sharing one pool across the whole process.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set - copy .env.example to .env first`);
  }
  return value;
}

/** Bypasses PgBouncer entirely - talks straight to the Postgres container. */
export function directConnectionString(): string {
  return requireEnv("DATABASE_URL");
}

/** Through the PgBouncer instance configured with pool_mode=session. */
export function sessionPoolingConnectionString(): string {
  return requireEnv("DATABASE_URL_PGBOUNCER_SESSION");
}

/** Through the PgBouncer instance configured with pool_mode=transaction. */
export function transactionPoolingConnectionString(): string {
  return requireEnv("DATABASE_URL_PGBOUNCER_TRANSACTION");
}

/**
 * PgBouncer exposes an admin console as a virtual database named
 * "pgbouncer" on the same port as the pooled database. Connecting to it
 * (as one of PgBouncer's ADMIN_USERS) lets you run SHOW POOLS / SHOW
 * CLIENTS / SHOW SERVERS / SET <param> = <value> - see
 * https://www.pgbouncer.org/usage.html. Swaps only the database name in the
 * target connection string; same host, port, and credentials.
 */
export function toAdminConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  url.pathname = "/pgbouncer";
  return url.toString();
}

/**
 * Tags a connection string with an `application_name`. `application_name`
 * is one of the startup parameters PgBouncer tracks and automatically
 * replays onto whatever real backend ends up serving a client - in every
 * pool mode, including transaction - so it is a reliable way to identify
 * "connections opened by this lab's own scenario code" in `pg_stat_activity`
 * regardless of which backend PgBouncer hands them, without also matching
 * unrelated connections (e.g. PGweb's own persistent connection, which uses
 * the same database user).
 */
export function withApplicationName(connectionString: string, applicationName: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}
