import { Client } from "pg";

export interface ProbeSample {
  attempt: number;
  latencyMs: number;
}

export interface WriteProber {
  stop: () => Promise<ProbeSample[]>;
}

/**
 * Simulates a stream of ORDINARY, unrelated application requests, each
 * issuing a single-row `UPDATE orders SET status = status WHERE id = $1` -
 * exactly the kind of write a real user action ("cancel my order", "mark
 * shipped") would perform, completely unrelated to any backfill. Each
 * attempt opens its OWN fresh connection (the way a real application's
 * connection pool hands a request a connection, uses it, and returns it),
 * rather than reusing one long-lived client - so what's being measured is
 * genuinely "can an ordinary request touching this row make progress right
 * now," not an artifact of one client's serialized query queue.
 *
 * Used by both the naive scenario (to prove ordinary writes are blocked for
 * the giant UPDATE's entire duration) and the batched scenario (to prove
 * they are NOT meaningfully affected between short-lived batch
 * transactions) - the SAME measurement technique, so the two results are a
 * fair, apples-to-apples comparison.
 */
export function startWriteProber(connectionString: string, orderId: number, intervalMs: number): WriteProber {
  const samples: ProbeSample[] = [];
  let stopped = false;
  let attempt = 0;

  const loopPromise = (async () => {
    while (!stopped) {
      attempt += 1;
      const thisAttempt = attempt;
      const client = new Client({ connectionString });
      const startedAt = performance.now();
      try {
        await client.connect();
        await client.query("UPDATE orders SET status = status WHERE id = $1", [orderId]);
      } finally {
        await client.end();
      }
      samples.push({ attempt: thisAttempt, latencyMs: performance.now() - startedAt });

      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();

  return {
    async stop(): Promise<ProbeSample[]> {
      stopped = true;
      await loopPromise;
      return samples;
    },
  };
}

/**
 * A single, one-off ordinary write against `orderId`, used for baseline
 * ("no contention at all") latency measurements before any backfill starts.
 */
export async function measureSingleWrite(connectionString: string, orderId: number): Promise<number> {
  const client = new Client({ connectionString });
  const startedAt = performance.now();
  try {
    await client.connect();
    await client.query("UPDATE orders SET status = status WHERE id = $1", [orderId]);
  } finally {
    await client.end();
  }
  return performance.now() - startedAt;
}

export interface LatencySummary {
  count: number;
  minMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export function summarizeLatencies(samples: ProbeSample[]): LatencySummary {
  const sorted = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { count: 0, minMs: 0, p50Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  const pick = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number;
  return {
    count: sorted.length,
    minMs: Number((sorted[0] as number).toFixed(2)),
    p50Ms: Number(pick(0.5).toFixed(2)),
    p99Ms: Number(pick(0.99).toFixed(2)),
    maxMs: Number((sorted[sorted.length - 1] as number).toFixed(2)),
  };
}
