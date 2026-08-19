import "dotenv/config";
import { Client } from "pg";
import { createLogger } from "@labs/logging";
import { runConcurrently } from "@labs/test-utils";
import { directConnectionString } from "../db/connections.js";

const log = createLogger("lab23:scenario:direct-overhead");

/**
 * "Break it": open many DIRECT connections to Postgres - bypassing PgBouncer
 * entirely - and watch it fall over. Every Postgres connection is a full OS
 * backend process; the server's `max_connections` (deliberately lowered to
 * 30 for this lab, see .env.example) is a hard ceiling, not a soft one. Once
 * it's reached, Postgres rejects new connections with a real
 * `FATAL: sorry, too many clients already` (SQLSTATE 53300) - it does not
 * queue them.
 */

export interface DirectConnectionAttempt {
  status: "success" | "rejected";
  workerId: number;
  durationMs: number;
  backendPid?: number;
  errorCode?: string;
  message?: string;
}

async function attemptDirectConnection(workerId: number, holdMs: number): Promise<DirectConnectionAttempt> {
  const start = Date.now();
  const client = new Client({ connectionString: directConnectionString() });
  try {
    await client.connect();
    const { rows } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
    // Hold the connection open so many workers are genuinely concurrent at
    // the Postgres server - a connect-query-disconnect loop with no hold
    // would finish too fast for the attempts to overlap and would never
    // actually hit max_connections.
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    await client.query("select 1");
    await client.end();
    const durationMs = Date.now() - start;
    log.info({ workerId, durationMs, backendPid: rows[0]?.pid }, "direct connection succeeded");
    return { status: "success", workerId, durationMs, backendPid: rows[0]?.pid };
  } catch (error) {
    const durationMs = Date.now() - start;
    const pgError = error as { code?: string; message: string };
    log.error({ err: error, workerId, durationMs }, "direct connection rejected");
    await client.end().catch(() => undefined);
    return { status: "rejected", workerId, durationMs, errorCode: pgError.code, message: pgError.message };
  }
}

export interface DirectConnectionOverheadSummary {
  concurrentConnections: number;
  wallClockMs: number;
  succeeded: number;
  rejected: number;
  tooManyClientsAlready: number;
  attempts: DirectConnectionAttempt[];
}

export async function runDirectConnectionOverhead(
  concurrentConnections = Number(process.env.SCENARIO_CONNECTIONS ?? 50),
  holdMs = Number(process.env.SCENARIO_HOLD_MS ?? 300),
): Promise<DirectConnectionOverheadSummary> {
  log.info(
    { concurrentConnections, holdMs },
    "opening direct connections against Postgres, bypassing PgBouncer entirely",
  );

  const wallClockStart = Date.now();
  const settled = await runConcurrently(concurrentConnections, (workerId) =>
    attemptDirectConnection(workerId, holdMs),
  );
  const wallClockMs = Date.now() - wallClockStart;

  const attempts = settled.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : ({
          status: "rejected",
          workerId: index,
          durationMs: -1,
          message: String(result.reason),
        } satisfies DirectConnectionAttempt),
  );

  const succeeded = attempts.filter((a) => a.status === "success");
  const rejected = attempts.filter((a) => a.status === "rejected");
  const tooManyClientsAlready = rejected.filter((a) => a.errorCode === "53300");

  const summary: DirectConnectionOverheadSummary = {
    concurrentConnections,
    wallClockMs,
    succeeded: succeeded.length,
    rejected: rejected.length,
    tooManyClientsAlready: tooManyClientsAlready.length,
    attempts,
  };

  log.info(
    {
      concurrentConnections,
      wallClockMs,
      succeeded: summary.succeeded,
      rejected: summary.rejected,
      tooManyClientsAlready: summary.tooManyClientsAlready,
    },
    "direct-connection-overhead summary",
  );

  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDirectConnectionOverhead()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      log.error({ err: error }, "scenario failed");
      process.exit(1);
    });
}
