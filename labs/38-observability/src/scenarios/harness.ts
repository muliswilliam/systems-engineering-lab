import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "node:http";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { createStructuredLogger, flushStructuredLogger } from "../observability/request-logger.js";
import { createObservableServer } from "../server/server.js";
import { registry } from "../observability/metrics.js";

export interface LabServerHandle {
  server: Server;
  logger: Logger;
  baseUrl: string;
  structuredLogFile: string;
  naiveLogFile: string;
  flushLogs: () => Promise<void>;
  close: () => Promise<void>;
}

/** Truncates (or creates) both log files so a scenario/test run's
 * aggregates reflect ONLY the traffic it generates, not a previous run's
 * leftovers. */
export function resetLogFiles(structuredLogFile: string, naiveLogFile: string): void {
  for (const file of [structuredLogFile, naiveLogFile]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
}

/**
 * Starts this lab's real HTTP service in-process on `APP_PORT`, against a
 * fresh pair of log files, and resets every `prom-client` metric to zero
 * first - every scenario and test gets an isolated, from-zero view of
 * "what happened in THIS run", the same reasoning Lab 31's per-test
 * `pg_stat_reset_single_table_counters` documents for its own counters.
 */
export async function startLabServer(
  pool: Pool,
  port: number,
  structuredLogFile: string,
  naiveLogFile: string,
): Promise<LabServerHandle> {
  resetLogFiles(structuredLogFile, naiveLogFile);
  registry.resetMetrics();

  const logger = createStructuredLogger("lab38:http", structuredLogFile);
  const server = createObservableServer({ pool, logger, naiveLogFile });

  return new Promise<LabServerHandle>((resolve) => {
    server.listen(port, () => {
      resolve({
        server,
        logger,
        baseUrl: `http://localhost:${port}`,
        structuredLogFile,
        naiveLogFile,
        flushLogs: () => flushStructuredLogger(logger),
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
