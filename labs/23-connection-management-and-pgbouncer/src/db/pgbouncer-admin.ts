import { Client } from "pg";
import { toAdminConnectionString } from "./connections.js";

/**
 * PgBouncer exposes its own config and pool state through a special virtual
 * database named "pgbouncer" (see toAdminConnectionString). Any user listed
 * in ADMIN_USERS can connect to it and run SHOW/SET/RELOAD commands - see
 * https://www.pgbouncer.org/usage.html. This is how pool-size-tuning.ts
 * changes `default_pool_size` at runtime without restarting the container.
 */

interface ShowConfigRow {
  key: string;
  value: string;
  default: string;
  changeable: string;
}

export async function getDefaultPoolSize(connectionString: string): Promise<number> {
  const admin = new Client({ connectionString: toAdminConnectionString(connectionString) });
  await admin.connect();
  try {
    const { rows } = await admin.query<ShowConfigRow>("SHOW CONFIG");
    const row = rows.find((r) => r.key === "default_pool_size");
    if (!row) {
      throw new Error("default_pool_size not present in PgBouncer SHOW CONFIG output");
    }
    return Number(row.value);
  } finally {
    await admin.end();
  }
}

export async function setDefaultPoolSize(connectionString: string, size: number): Promise<void> {
  const admin = new Client({ connectionString: toAdminConnectionString(connectionString) });
  await admin.connect();
  try {
    // PgBouncer's admin console does not accept query parameters; `size` is
    // always an internally-generated integer in this lab, never user input.
    await admin.query(`SET default_pool_size = ${Math.trunc(size)}`);
  } finally {
    await admin.end();
  }
}

/**
 * `SET default_pool_size` only caps how many NEW real server connections
 * PgBouncer is willing to open - it does not retroactively close server
 * connections that were already open before the setting was lowered. So
 * lowering the pool size after PgBouncer has already warmed up to a larger
 * number of idle backends (from earlier scenario runs in the same
 * `docker compose up` session) would silently let a "small pool" test keep
 * using the old, larger number of backends. `KILL <database>` forcibly
 * closes every current client and server connection for that database
 * immediately, so the next burst of clients has to open fresh server
 * connections under whatever `default_pool_size` is configured right now -
 * see https://www.pgbouncer.org/usage.html.
 */
export async function killDatabaseConnections(connectionString: string): Promise<void> {
  const admin = new Client({ connectionString: toAdminConnectionString(connectionString) });
  await admin.connect();
  try {
    const dbName = new URL(connectionString).pathname.replace(/^\//, "");
    await admin.query(`KILL ${dbName}`);
    // Undocumented-but-observed PgBouncer 1.25 behavior worth knowing: KILL
    // leaves the database's `paused` flag set (visible in `SHOW DATABASES`),
    // which blocks every subsequent connection attempt indefinitely until
    // something explicitly RESUMEs it. Without this, new client connections
    // opened right after KILL would hang forever instead of getting a fresh
    // server connection.
    await admin.query(`RESUME ${dbName}`);
  } finally {
    await admin.end();
  }
}

interface ShowPoolsRow {
  database: string;
  user: string;
  cl_active: string;
  cl_waiting: string;
  sv_active: string;
  sv_idle: string;
  sv_used: string;
  pool_mode: string;
}

/** Snapshot of PgBouncer's own view of one database's pool. */
export async function showPools(connectionString: string): Promise<ShowPoolsRow[]> {
  const admin = new Client({ connectionString: toAdminConnectionString(connectionString) });
  await admin.connect();
  try {
    const { rows } = await admin.query<ShowPoolsRow>("SHOW POOLS");
    return rows;
  } finally {
    await admin.end();
  }
}
