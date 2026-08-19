import "dotenv/config";
import { Client } from "pg";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
import {
  directConnectionString,
  transactionPoolingConnectionString,
  withApplicationName,
} from "../db/connections.js";

const log = createLogger("lab23:scenario:transaction-pooling");

// Tags every scenario-opened connection so the pg_stat_activity monitor
// below can identify "backends serving this scenario's clients" and nothing
// else - in particular, not PGweb's own persistent direct connection, which
// authenticates as the same database user. See withApplicationName's
// docstring for why application_name specifically is a reliable tag to use
// here (PgBouncer always forwards it to the real backend, in every pool
// mode).
const APPLICATION_NAME = "lab23-transaction-pooling-scenario";

/**
 * "Fix it" (for stateless short queries): run the SAME number of concurrent
 * client "connections" through the transaction-pooling PgBouncer instance
 * instead of direct Postgres. They all succeed - even well beyond Postgres's
 * `max_connections` - because PgBouncer multiplexes many client connections
 * onto a small pool of real Postgres backend connections
 * (`default_pool_size`, set to 10 in docker-compose.yml). A background
 * monitor connects DIRECTLY to Postgres and polls `pg_stat_activity` for the
 * real, distinct backend PIDs in use, so the multiplexing claim is measured,
 * not just asserted.
 */

async function attemptPooledConnection(workerId: number, querySleepMs: number) {
  const start = Date.now();
  const client = new Client({
    connectionString: withApplicationName(transactionPoolingConnectionString(), APPLICATION_NAME),
  });
  await client.connect();
  const { rows } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
  // A trivial-but-not-instant query so the burst has enough width in time
  // for the pg_stat_activity monitor to observe real overlap.
  await client.query("select pg_sleep($1)", [querySleepMs / 1000]);
  await client.end();
  const durationMs = Date.now() - start;
  log.info({ workerId, durationMs, backendPid: rows[0]?.pid }, "pooled connection succeeded");
  return { workerId, durationMs, backendPid: rows[0]?.pid ?? -1 };
}

async function monitorBackendPids(
  monitorPool: ReturnType<typeof createPool>,
  stop: { requested: boolean },
): Promise<{ peakConcurrentBackends: number; distinctBackendPids: number[] }> {
  const seen = new Set<number>();
  let peak = 0;
  while (!stop.requested) {
    const { rows } = await monitorPool.query<{ pid: number }>(
      `select pid
       from pg_stat_activity
       where application_name = $1`,
      [APPLICATION_NAME],
    );
    peak = Math.max(peak, rows.length);
    for (const row of rows) seen.add(row.pid);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return { peakConcurrentBackends: peak, distinctBackendPids: [...seen] };
}

export interface TransactionPoolingSummary {
  concurrentClients: number;
  wallClockMs: number;
  succeeded: number;
  peakConcurrentBackends: number;
  distinctBackendPidCount: number;
}

export async function runTransactionPoolingScenario(
  concurrentClients = Number(process.env.SCENARIO_CONNECTIONS ?? 60),
  querySleepMs = Number(process.env.SCENARIO_QUERY_SLEEP_MS ?? 80),
): Promise<TransactionPoolingSummary> {
  const monitorPool = createPool({ connectionString: directConnectionString() });
  await waitForDatabase(monitorPool);

  const stop = { requested: false };
  const monitorPromise = monitorBackendPids(monitorPool, stop);

  log.info(
    { concurrentClients, querySleepMs },
    "opening client connections through the transaction-pooling PgBouncer instance",
  );

  const wallClockStart = Date.now();
  const settled = await runConcurrently(concurrentClients, (workerId) =>
    attemptPooledConnection(workerId, querySleepMs),
  );
  const wallClockMs = Date.now() - wallClockStart;

  stop.requested = true;
  const { peakConcurrentBackends, distinctBackendPids } = await monitorPromise;
  await monitorPool.end();

  const succeeded = countFulfilled(settled);

  const summary: TransactionPoolingSummary = {
    concurrentClients,
    wallClockMs,
    succeeded,
    peakConcurrentBackends,
    distinctBackendPidCount: distinctBackendPids.length,
  };

  log.info(summary, "pgbouncer-transaction-pooling summary");

  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTransactionPoolingScenario()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      log.error({ err: error }, "scenario failed");
      process.exit(1);
    });
}
