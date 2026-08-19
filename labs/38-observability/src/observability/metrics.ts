import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";
import type { Pool } from "pg";

/**
 * Why `prom-client` rather than hand-rolled counters (CLAUDE.md
 * "Dependencies": justify before adding one):
 *
 * - The Prometheus text exposition format has real, easy-to-get-wrong rules
 *   (label escaping/quoting, `# HELP`/`# TYPE` lines, histograms needing
 *   monotonically-increasing cumulative `_bucket{le=...}` lines plus `_sum`
 *   and `_count`). Hand-rolling this risks silently producing a `/metrics`
 *   endpoint that LOOKS right in a terminal but a real Prometheus server
 *   rejects or mis-parses - the opposite of what an observability lab should
 *   teach.
 * - `prom-client` is small, single-purpose, has no transitive framework
 *   dependencies, and is the de facto standard Node client for this exact
 *   job - it does not pull in an HTTP framework or anything this lab isn't
 *   already using.
 * - The alternative (hand-rolled primitives) would only be justified if the
 *   LESSON were "how the exposition format works internally" - it is not;
 *   the lesson here is "what a real service instruments and how an operator
 *   reads it", so a correct, standard client is the more honest choice.
 */
export const registry = new Registry();

// Real process-level metrics (CPU, memory, event loop lag, GC) - free,
// standard, and exactly what a real Node service would also expose.
collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests handled, labeled by method, route template, and status code",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds, labeled by method, route template, and status code",
  labelNames: ["method", "route", "status_code"] as const,
  // Buckets span this lab's own real latency mix: fast (~5-30ms) success,
  // 404s, deliberately slow (~250-600ms via a real pg_sleep) requests.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const httpRequestsInFlight = new Gauge({
  name: "http_requests_in_flight",
  help: "Number of HTTP requests currently being handled (entered, not yet responded)",
  registers: [registry],
});

export const httpErrorsTotal = new Counter({
  name: "http_errors_total",
  help: "Total HTTP requests that ended in a 5xx response, labeled by route template",
  labelNames: ["route"] as const,
  registers: [registry],
});

// "Queue depth" from ROADMAP.md's Lab 38 list, made concrete: `pg.Pool`
// tracks exactly this - clients waiting because every pooled connection is
// checked out is a REAL queue, not a stand-in metaphor for one.
export const dbPoolWaitingGauge = new Gauge({
  name: "db_pool_waiting_clients",
  help: "Number of clients currently queued waiting for a pooled Postgres connection (real queue depth)",
  registers: [registry],
});

export const dbPoolTotalGauge = new Gauge({
  name: "db_pool_total_clients",
  help: "Total number of clients (idle + checked out) currently held by the pg Pool",
  registers: [registry],
});

export const dbPoolIdleGauge = new Gauge({
  name: "db_pool_idle_clients",
  help: "Number of idle (not checked out) clients currently held by the pg Pool",
  registers: [registry],
});

/**
 * `pg.Pool` exposes `totalCount`/`idleCount`/`waitingCount` as plain
 * synchronous getters - no event subscription needed. Called once per
 * request (see `server.ts`) so the gauges are always fresh when `/metrics`
 * is scraped, the same "sample on demand" approach `collectDefaultMetrics`
 * itself uses internally.
 */
export function sampleDbPoolMetrics(pool: Pool): void {
  dbPoolTotalGauge.set(pool.totalCount);
  dbPoolIdleGauge.set(pool.idleCount);
  dbPoolWaitingGauge.set(pool.waitingCount);
}
