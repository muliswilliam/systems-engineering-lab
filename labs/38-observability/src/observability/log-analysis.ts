import { readFileSync } from "node:fs";
import { computeLatencyStats, type LatencyStats } from "./percentiles.js";

export interface StructuredLogEntry {
  time: number;
  level: number;
  name: string;
  requestId: string;
  route: string;
  method: string;
  step: string;
  statusCode?: number;
  durationMs?: number;
  outcome?: string;
  msg?: string;
  err?: { message?: string; type?: string };
  [key: string]: unknown;
}

/** Reads a pino ndjson file and parses every line as one JSON object. */
export function parseStructuredLog(filePath: string): StructuredLogEntry[] {
  const raw = readFileSync(filePath, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as StructuredLogEntry);
}

export interface RouteAggregate {
  route: string;
  total: number;
  errorCount: number;
  errorRate: number;
  latency: LatencyStats;
}

/**
 * The core "why structured logging matters" demonstration: one JSON.parse
 * per line plus a `group by route` gives EXACT p50/p95/p99 latency and an
 * EXACT error rate - the same query an operator would otherwise reach for a
 * log platform (Loki/Elasticsearch/CloudWatch Insights) to run, done here
 * directly against the raw file because every field is already named and
 * typed consistently.
 */
export function aggregateByRoute(entries: StructuredLogEntry[]): RouteAggregate[] {
  const completions = entries.filter((e) => e.step === "request.complete");
  const byRoute = new Map<string, StructuredLogEntry[]>();
  for (const entry of completions) {
    const list = byRoute.get(entry.route) ?? [];
    list.push(entry);
    byRoute.set(entry.route, list);
  }

  const aggregates: RouteAggregate[] = [];
  for (const [route, routeEntries] of byRoute) {
    const durations = routeEntries.map((e) => e.durationMs ?? 0);
    const errorCount = routeEntries.filter((e) => e.outcome === "error").length;
    aggregates.push({
      route,
      total: routeEntries.length,
      errorCount,
      errorRate: Number((errorCount / routeEntries.length).toFixed(4)),
      latency: computeLatencyStats(durations),
    });
  }
  return aggregates.sort((a, b) => b.total - a.total);
}

export interface NaiveParseResult {
  totalLines: number;
  successfullyParsed: number;
  failedToParse: number;
  wronglyClassifiedAsSuccess: number;
}

/**
 * A REAL, best-effort attempt to recover the same per-request facts (route,
 * duration, outcome) from `naive.log`'s free-text lines using regexes - the
 * point is that this genuinely partially works (some lines DO match) but is
 * fragile and silently wrong in ways JSON.parse on structured logs never is:
 * - the "took X ms" format's `X ms` capture works, but "completed in Xms"
 *   (no space) needs a DIFFERENT regex, so a single regex missing that
 *   variant simply drops those lines from the aggregate with no error;
 * - `ERROR handling request to ...` lines carry no duration at all - a naive
 *   parser either has to skip them (undercounting errors in a duration
 *   aggregate) or invent a fake duration;
 * - nothing here is a schema an operator could validate against; a
 *   deliberately typo'd future log line degrades silently instead of
 *   failing loudly the way `JSON.parse` would.
 */
export function attemptNaiveLogParse(filePath: string): NaiveParseResult {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);

  // Only handles ONE of the three real formats this lab's own naive logger
  // writes (`Request completed in ${ms}ms for ${route}`) - exactly the kind
  // of regex a real engineer would write after looking at a HANDFUL of
  // sample lines, not realizing two teammates' code paths format it
  // differently.
  const singleFormatRegex = /^Request completed in ([\d.]+)ms for (\S+)$/;

  let successfullyParsed = 0;
  let wronglyClassifiedAsSuccess = 0;
  for (const line of lines) {
    const match = singleFormatRegex.exec(line);
    if (match) {
      successfullyParsed += 1;
      // This regex has no concept of "outcome" at all - EVERY line it
      // matches gets silently treated as a success, including any line
      // that happens to fit the pattern but was not actually a 2xx/3xx
      // response, because the free-text format never named that field.
      wronglyClassifiedAsSuccess += 1;
    }
  }

  return {
    totalLines: lines.length,
    successfullyParsed,
    failedToParse: lines.length - successfullyParsed,
    wronglyClassifiedAsSuccess,
  };
}
