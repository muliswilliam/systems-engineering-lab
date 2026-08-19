import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Pool } from "pg";
import type { Logger } from "pino";
import {
  registry,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  httpRequestsInFlight,
  httpErrorsTotal,
  sampleDbPoolMetrics,
} from "../observability/metrics.js";
import { appendNaiveLogLine } from "../observability/request-logger.js";
import { findOrderById, insertOrder } from "./order-queries.js";
import { buildOrderView } from "./business-logic.js";

export interface ServerDeps {
  pool: Pool;
  logger: Logger;
  naiveLogFile: string;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
}

function send(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(payload);
}

/**
 * Creates the lab's HTTP service using Node's built-in `http` module -
 * deliberately not Express/Fastify/etc. (CLAUDE.md "Dependencies": the task
 * this lab teaches is instrumentation, not routing; a bare `http.Server`
 * keeps every request-lifecycle step - where a correlation ID is minted,
 * where a timer starts, where a metric is recorded - fully visible in this
 * one file instead of hidden inside framework middleware).
 *
 * Every request is traced through the SAME four steps the ROADMAP.md Lab 38
 * entry names: `request.start` (HTTP handler) -> `business_logic.*` ->
 * `db.query.*` -> `request.complete` (response), all logged through one
 * `requestId`-bound child logger, and also recorded into every metric this
 * lab exposes at `/metrics`.
 */
export function createObservableServer(deps: ServerDeps): Server {
  const { pool, logger, naiveLogFile } = deps;

  return createHttpServer((req, res) => {
    void handleRequest(req, res, pool, logger, naiveLogFile);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pool: Pool,
  logger: Logger,
  naiveLogFile: string,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();

  const orderIdMatch = /^\/orders\/(\d+)$/.exec(url.pathname);
  const route = url.pathname === "/orders" ? "/orders" : orderIdMatch ? "/orders/:id" : url.pathname;

  const log = logger.child({ requestId, route, method });
  const requestStart = performance.now();
  httpRequestsInFlight.inc();
  log.info({ step: "request.start" }, "request start");

  let statusCode = 200;
  let outcome = "success";
  let errorForLog: unknown;

  try {
    if (method === "GET" && url.pathname === "/health") {
      send(res, 200, { status: "ok" });
    } else if (method === "GET" && url.pathname === "/metrics") {
      const body = await registry.metrics();
      res.writeHead(200, { "Content-Type": registry.contentType });
      res.end(body);
    } else if (method === "GET" && orderIdMatch) {
      const id = Number(orderIdMatch[1]);
      const slow = url.searchParams.get("slow") === "1";
      const order = await findOrderById(pool, id, { slow }, log);
      if (!order) {
        statusCode = 404;
        outcome = "not_found";
        send(res, 404, { error: "order not found", orderId: id });
      } else {
        const view = buildOrderView(order, log);
        statusCode = 200;
        outcome = "success";
        send(res, 200, view);
      }
    } else if (method === "POST" && url.pathname === "/orders") {
      const body = await readJsonBody(req);
      const created = await insertOrder(
        pool,
        {
          customerEmail: (body.customerEmail as string | null | undefined) ?? null,
          amountCents: Number(body.amountCents ?? 0),
        },
        log,
      );
      statusCode = 201;
      outcome = "success";
      send(res, 201, created);
    } else {
      statusCode = 404;
      outcome = "not_found";
      send(res, 404, { error: "not found" });
    }
  } catch (error: unknown) {
    statusCode = 500;
    outcome = "error";
    errorForLog = error;
    send(res, 500, { error: "internal server error" });
  } finally {
    const durationMs = performance.now() - requestStart;
    httpRequestsInFlight.dec();
    sampleDbPoolMetrics(pool);

    httpRequestsTotal.inc({ method, route, status_code: String(statusCode) });
    httpRequestDurationSeconds.observe({ method, route, status_code: String(statusCode) }, durationMs / 1000);
    if (statusCode >= 500) {
      httpErrorsTotal.inc({ route });
    }

    if (errorForLog !== undefined) {
      // Literal `err` key - Pino's built-in Error serializer only binds to
      // this exact key (see CLAUDE.md "critical logging convention").
      log.error(
        { err: errorForLog, step: "request.complete", statusCode, outcome, durationMs: Number(durationMs.toFixed(2)) },
        "request failed",
      );
    } else {
      log.info(
        { step: "request.complete", statusCode, outcome, durationMs: Number(durationMs.toFixed(2)) },
        "request complete",
      );
    }

    appendNaiveLogLine(naiveLogFile, { route, method, statusCode, durationMs, outcome });
  }
}
