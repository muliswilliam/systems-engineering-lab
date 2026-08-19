import pino, { type Logger } from "pino";

export type LogContext = Record<string, unknown>;

/**
 * Creates a structured Pino logger for a lab process (API, worker, seed script, ...).
 * `bindings` are attached to every log line so concurrent workers stay distinguishable
 * (workerId, jobId, transactionId, attempt, etc. - see SPEC.md Logging Standards).
 */
export function createLogger(name: string, bindings: LogContext = {}): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "HH:MM:ss.l",
              ignore: "pid,hostname",
            },
          },
  }).child(bindings);
}
