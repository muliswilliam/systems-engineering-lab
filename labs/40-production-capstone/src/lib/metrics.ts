import http, { type Server } from "node:http";
import { createLogger } from "@labs/logging";

const log = createLogger("lab40:metrics");

/**
 * A deliberately minimal metrics registry - counters and gauges only, no
 * histograms/percentiles - exposed over plain `node:http` in Prometheus text
 * exposition format. This is this lab's own fresh implementation of
 * SPEC.md Lab 38's "add ... metrics ... a `/metrics` endpoint" requirement
 * for the capstone, not an import from Lab 38 (a sibling, independently
 * built lab as of this writing - per the independent-labs principle this
 * lab must not depend on it even if it existed).
 *
 * Real Prometheus client libraries (`prom-client`) exist and would be the
 * production choice; this lab writes its own ~60 lines instead so nothing
 * about "what a counter/gauge actually is" is hidden - see README
 * "Tradeoffs".
 */
export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly helpText = new Map<string, string>();

  private key(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return name;
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
    return `${name}{${labelStr}}`;
  }

  incrementCounter(name: string, labels?: Record<string, string>, by = 1, help?: string): void {
    if (help) this.helpText.set(name, help);
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  setGauge(name: string, value: number, labels?: Record<string, string>, help?: string): void {
    if (help) this.helpText.set(name, help);
    const key = this.key(name, labels);
    this.gauges.set(key, value);
  }

  getCounter(name: string, labels?: Record<string, string>): number {
    return this.counters.get(this.key(name, labels)) ?? 0;
  }

  getGauge(name: string, labels?: Record<string, string>): number {
    return this.gauges.get(this.key(name, labels)) ?? 0;
  }

  /** Prometheus text exposition format (0.0.4). Good enough for `curl` and a real scraper alike. */
  render(): string {
    const lines: string[] = [];
    const seenHelp = new Set<string>();
    const emit = (map: Map<string, number>, type: "counter" | "gauge") => {
      for (const [key, value] of map.entries()) {
        const baseName = key.split("{")[0]!;
        if (!seenHelp.has(baseName)) {
          seenHelp.add(baseName);
          const help = this.helpText.get(baseName);
          if (help) lines.push(`# HELP ${baseName} ${help}`);
          lines.push(`# TYPE ${baseName} ${type}`);
        }
        lines.push(`${key} ${value}`);
      }
    };
    emit(this.counters, "counter");
    emit(this.gauges, "gauge");
    return lines.join("\n") + "\n";
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
  }
}

/** One process-wide registry - every module in this lab imports this singleton. */
export const metrics = new MetricsRegistry();

export function startMetricsServer(port: number): Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(metrics.render());
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  server.listen(port, () => {
    log.info({ port }, "metrics server listening (GET /metrics, GET /health)");
  });
  return server;
}
