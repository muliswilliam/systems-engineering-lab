import "dotenv/config";
import { Client } from "pg";
import { createLogger } from "@labs/logging";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
import { transactionPoolingConnectionString } from "../db/connections.js";
import { getDefaultPoolSize, killDatabaseConnections, setDefaultPoolSize } from "../db/pgbouncer-admin.js";

const log = createLogger("lab23:scenario:pool-size-tuning");

/**
 * `default_pool_size` is itself a tuning knob with a real throughput/
 * queueing tradeoff: too small and concurrent clients queue behind a small
 * number of real Postgres backends even though Postgres has plenty of
 * `max_connections` headroom; too large and you lose the whole point of
 * pooling (many client connections, few expensive server connections).
 *
 * This scenario runs the SAME concurrent client load against the SAME
 * transaction-pooling PgBouncer instance twice, changing only
 * `default_pool_size` via PgBouncer's admin console between runs (see
 * src/db/pgbouncer-admin.ts) - no container restart needed, PgBouncer
 * applies most settings, including this one, live.
 */

async function runBurst(concurrentClients: number, querySleepMs: number): Promise<number> {
  const start = Date.now();
  const settled = await runConcurrently(concurrentClients, async () => {
    const client = new Client({ connectionString: transactionPoolingConnectionString() });
    await client.connect();
    await client.query("select pg_sleep($1)", [querySleepMs / 1000]);
    await client.end();
  });
  const wallClockMs = Date.now() - start;
  const succeeded = countFulfilled(settled);
  if (succeeded !== concurrentClients) {
    log.warn({ succeeded, concurrentClients }, "not every client succeeded in this burst");
  }
  return wallClockMs;
}

export interface PoolSizeTuningSummary {
  concurrentClients: number;
  querySleepMs: number;
  smallPoolSize: number;
  largePoolSize: number;
  smallPoolWallClockMs: number;
  largePoolWallClockMs: number;
}

export async function runPoolSizeTuningScenario(
  concurrentClients = Number(process.env.SCENARIO_CONNECTIONS ?? 40),
  querySleepMs = Number(process.env.SCENARIO_QUERY_SLEEP_MS ?? 50),
  smallPoolSize = Number(process.env.SCENARIO_SMALL_POOL ?? 2),
  largePoolSize = Number(process.env.SCENARIO_LARGE_POOL ?? 20),
): Promise<PoolSizeTuningSummary> {
  const connectionString = transactionPoolingConnectionString();
  const originalPoolSize = await getDefaultPoolSize(connectionString);

  try {
    log.info({ smallPoolSize, concurrentClients }, "measuring burst with a small pool");
    await setDefaultPoolSize(connectionString, smallPoolSize);
    // Force any backends left over from earlier scenario runs to close, so
    // this burst genuinely has to reopen (at most) smallPoolSize backends
    // rather than coasting on a previously-larger warm pool.
    await killDatabaseConnections(connectionString);
    const smallPoolWallClockMs = await runBurst(concurrentClients, querySleepMs);

    log.info({ largePoolSize, concurrentClients }, "measuring the same burst with a larger pool");
    await setDefaultPoolSize(connectionString, largePoolSize);
    await killDatabaseConnections(connectionString);
    const largePoolWallClockMs = await runBurst(concurrentClients, querySleepMs);

    const summary: PoolSizeTuningSummary = {
      concurrentClients,
      querySleepMs,
      smallPoolSize,
      largePoolSize,
      smallPoolWallClockMs,
      largePoolWallClockMs,
    };

    log.info(summary, "pool-size-tuning summary");

    return summary;
  } finally {
    // Leave the pool exactly as docker-compose.yml configured it
    // (DEFAULT_POOL_SIZE=10) so later scenario runs and tests in the same
    // `docker compose up` session are not affected by this experiment - and
    // kill once more so no backends opened during the largePoolSize run
    // (which could exceed the restored, smaller original size) linger
    // around as idle leftovers for whatever runs next.
    await setDefaultPoolSize(connectionString, originalPoolSize);
    await killDatabaseConnections(connectionString);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPoolSizeTuningScenario()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      log.error({ err: error }, "scenario failed");
      process.exit(1);
    });
}
