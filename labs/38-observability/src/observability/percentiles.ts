/**
 * Nearest-rank percentile over a sorted-in-place copy of `values`. Simple
 * and exact for this lab's scale (hundreds of requests); a production
 * system at much higher cardinality would use `prom-client`'s own Histogram
 * bucket approximation instead of raw sample storage - see README
 * "Production notes".
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const clamped = Math.min(Math.max(rank, 0), sorted.length - 1);
  return sorted[clamped]!;
}

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

export function computeLatencyStats(durationsMs: number[]): LatencyStats {
  if (durationsMs.length === 0) {
    return { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
  }
  return {
    count: durationsMs.length,
    p50: Number(percentile(durationsMs, 50).toFixed(2)),
    p95: Number(percentile(durationsMs, 95).toFixed(2)),
    p99: Number(percentile(durationsMs, 99).toFixed(2)),
    min: Number(Math.min(...durationsMs).toFixed(2)),
    max: Number(Math.max(...durationsMs).toFixed(2)),
  };
}
