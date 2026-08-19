import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import pino, { type Logger } from "pino";

/**
 * A lab-local logger, NOT `@labs/logging`'s `createLogger` - deliberately.
 * `@labs/logging` is shared across every lab in this repo, and this lab
 * needs a second, durable output that every other lab does not: a raw
 * newline-delimited-JSON FILE (not just pretty stdout) that the
 * log-aggregation and tracing scenarios read back and parse. Adding a
 * file-destination option to the shared package purely for this one lab
 * would risk changing behavior other labs depend on - see CLAUDE.md
 * "Preserve independent labs" and "When Modifying an Existing Lab".
 *
 * `pino.transport` with multiple `targets` sends every log call to BOTH
 * destinations from one logger call site: a human-readable, colorized
 * stream to stdout (via `pino-pretty`, for a person watching `pnpm dev` or
 * a scenario script run) and a plain, unformatted stream to a `.log` file
 * (real structured JSON, one object per line - what the aggregation script
 * parses). This mirrors a genuine production pattern: pretty console output
 * in a terminal, durable structured JSON shipped somewhere queryable.
 */
export function createStructuredLogger(name: string, structuredLogFile: string): Logger {
  mkdirSync(dirname(structuredLogFile), { recursive: true });

  const transport = pino.transport({
    targets: [
      {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
        level: "info",
      },
      {
        target: "pino/file",
        options: { destination: structuredLogFile, mkdir: true },
        level: "info",
      },
    ],
  });

  return pino({ name, level: "info" }, transport);
}

/**
 * `pino.transport` ships log lines to a worker thread asynchronously - a
 * scenario/test that writes traffic and then immediately reads
 * `structured.log` back can otherwise race the worker's own write. `flush`
 * sends an explicit flush signal to the transport worker and resolves once
 * it acknowledges every buffered line has been written, so callers can read
 * the file right after `await flushStructuredLogger(logger)` with no sleep.
 */
export function flushStructuredLogger(logger: Logger): Promise<void> {
  return new Promise((resolve) => {
    logger.flush(() => resolve());
  });
}

/**
 * The DELIBERATELY BAD comparison point for the structured-logging scenario:
 * three different hand-written free-text formats for the "same" event,
 * exactly the way three different engineers writing `console.log`/
 * `logger.info(string)` calls over a codebase's lifetime actually produce
 * inconsistent logs - different word order, different units, different
 * field names, some fields simply missing. Deliberately NOT pino, NOT JSON -
 * this is the "before" side of the comparison.
 */
export function appendNaiveLogLine(
  naiveLogFile: string,
  event: { route: string; method: string; statusCode: number; durationMs: number; outcome: string },
): void {
  mkdirSync(dirname(naiveLogFile), { recursive: true });
  // Rounds BEFORE taking the modulus - `durationMs` is a float, and
  // `(int + float) % 3` is itself almost never exactly `0` or `1`, which
  // would silently collapse every non-error line onto the SAME third
  // format instead of the intended three-way mix.
  const variant = (event.route.length + Math.round(event.durationMs)) % 3;
  let line: string;
  if (event.outcome === "error") {
    line = `ERROR handling request to ${event.route}: ${event.outcome} (status ${event.statusCode})`;
  } else if (variant === 0) {
    line = `Request completed in ${event.durationMs.toFixed(1)}ms for ${event.route}`;
  } else if (variant === 1) {
    line = `${event.method} ${event.route} took ${Math.round(event.durationMs)} ms, ${event.outcome}`;
  } else {
    line = `[${event.method}] ${event.route} -> ${event.statusCode} (${event.outcome})`;
  }
  appendFileSync(naiveLogFile, `${line}\n`);
}
