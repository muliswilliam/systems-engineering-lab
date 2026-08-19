import { Client } from "pg";

export interface ProbeSample {
  attempt: number;
  latencyMs: number;
}

export interface WriteProber {
  stop: () => Promise<ProbeSample[]>;
}

/**
 * Simulates a stream of ORDINARY, unrelated application writes against ONE
 * row of `page_views` - exactly what a real "record a page view" request
 * would do, completely unrelated to any VACUUM operation running elsewhere.
 * Each attempt opens its OWN fresh connection (the way a real connection
 * pool hands a request a connection, uses it, and returns it) so what's
 * measured is genuinely "can an ordinary request touching this row make
 * progress right now," not an artifact of one client's serialized query
 * queue. Same measurement technique Lab 30's `write-prober.ts` established,
 * rebuilt fresh for this lab's own `page_views` table/column shape per the
 * independent-labs principle.
 */
export function startWriteProber(connectionString: string, rowId: number, intervalMs: number): WriteProber {
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
        await client.query("UPDATE page_views SET view_count = view_count + 1 WHERE id = $1", [rowId]);
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
 * Runs several `startWriteProber` loops CONCURRENTLY against the same row
 * and merges all of their samples into one array on `stop()`.
 *
 * VACUUM FULL's ACCESS EXCLUSIVE lock is held for the statement's entire
 * duration, but in this lab's own dataset sizes that duration can be well
 * under 200ms - too short for a SINGLE sequential prober (which spends most
 * of each cycle connecting/disconnecting) to reliably have an attempt
 * in-flight at the exact moment the lock is requested. Running many
 * concurrent probers dramatically increases the odds that at least one
 * (usually several) of them are genuinely queued behind the lock when it is
 * held, and once VACUUM FULL commits, every one of those queued attempts
 * completes back-to-back, showing up as a cluster of samples whose latency
 * tracks the remaining lock hold time - a robust, multi-sample proof of
 * blocking instead of a single sample that depends on lucky timing.
 */
export function startConcurrentWriteProbers(
  connectionString: string,
  rowId: number,
  concurrency: number,
  intervalMs: number,
): WriteProber {
  const probers = Array.from({ length: concurrency }, () => startWriteProber(connectionString, rowId, intervalMs));
  return {
    async stop(): Promise<ProbeSample[]> {
      const allSamples = await Promise.all(probers.map((p) => p.stop()));
      return allSamples.flat();
    },
  };
}

export async function measureSingleWrite(connectionString: string, rowId: number): Promise<number> {
  const client = new Client({ connectionString });
  const startedAt = performance.now();
  try {
    await client.connect();
    await client.query("UPDATE page_views SET view_count = view_count + 1 WHERE id = $1", [rowId]);
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
