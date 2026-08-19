import "dotenv/config";
import { createLogger } from "@labs/logging";
import { pool, waitForDatabase } from "../db/client.js";
import { createStructuredLogger } from "../observability/request-logger.js";
import { createObservableServer } from "./server.js";

const bootLog = createLogger("lab38:server");

async function main() {
  await waitForDatabase(pool);

  const port = Number(process.env.APP_PORT ?? 4438);
  const structuredLogFile = process.env.STRUCTURED_LOG_FILE ?? "logs/structured.log";
  const naiveLogFile = process.env.NAIVE_LOG_FILE ?? "logs/naive.log";

  const requestLogger = createStructuredLogger("lab38:http", structuredLogFile);
  const server = createObservableServer({ pool, logger: requestLogger, naiveLogFile });

  server.listen(port, () => {
    bootLog.info({ port, structuredLogFile, naiveLogFile }, "lab-38 observable service listening");
    bootLog.info({ url: `http://localhost:${port}/metrics` }, "Prometheus text-format metrics available here");
  });
}

main().catch((error: unknown) => {
  bootLog.error({ err: error }, "server failed to start");
  process.exit(1);
});
