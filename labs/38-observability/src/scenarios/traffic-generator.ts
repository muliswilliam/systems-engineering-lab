import type { Pool } from "pg";

/** Deterministic seeded PRNG (mulberry32) - no extra dependency needed for
 * a single `[0,1)` stream, and reproducible across runs given the same
 * seed, per CLAUDE.md's determinism rule. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface IdPools {
  validIds: number[];
  guestIds: number[];
}

/**
 * Reads back which seeded rows have a real email (fast/slow-bucket
 * candidates) vs. `customer_email IS NULL` (the guest-checkout rows that
 * trigger `buildOrderView`'s real bug) - this lab's traffic mix is built
 * from the ACTUAL seeded data, not a separately hand-maintained id list.
 */
export async function loadIdPools(pool: Pool): Promise<IdPools> {
  const [validResult, guestResult] = await Promise.all([
    pool.query("SELECT id FROM orders WHERE customer_email IS NOT NULL ORDER BY id"),
    pool.query("SELECT id FROM orders WHERE customer_email IS NULL ORDER BY id"),
  ]);
  return {
    validIds: validResult.rows.map((r: { id: number }) => r.id),
    guestIds: guestResult.rows.map((r: { id: number }) => r.id),
  };
}

export type TrafficOutcome = "success" | "not_found" | "slow" | "error" | "created";

export interface TrafficResult {
  bucket: TrafficOutcome;
  method: string;
  path: string;
  statusCode: number;
  clientDurationMs: number;
}

export interface TrafficMixCounts {
  fast: number;
  notFound: number;
  slow: number;
  error: number;
  create: number;
}

/**
 * This lab's realistic traffic mix, per CLAUDE.md "generate realistic
 * traffic patterns, not meaningless randomness": 65% fast successful order
 * lookups, 10% lookups for an id that genuinely does not exist (real 404s),
 * 10% deliberately slow lookups (real `pg_sleep`-backed latency spikes),
 * 10% lookups that hit a real guest-checkout row and trip the real
 * null-email bug (real 500s), 5% order creation. Weights sum to 1.0.
 */
const WEIGHTS: Array<{ bucket: TrafficOutcome; weight: number }> = [
  { bucket: "success", weight: 0.65 },
  { bucket: "not_found", weight: 0.1 },
  { bucket: "slow", weight: 0.1 },
  { bucket: "error", weight: 0.1 },
  { bucket: "created", weight: 0.05 },
];

function pickBucket(roll: number): TrafficOutcome {
  let cumulative = 0;
  for (const { bucket, weight } of WEIGHTS) {
    cumulative += weight;
    if (roll <= cumulative) return bucket;
  }
  return "success";
}

export async function generateTraffic(
  baseUrl: string,
  count: number,
  seed: number,
  ids: IdPools,
): Promise<TrafficResult[]> {
  const rng = mulberry32(seed);
  const results: TrafficResult[] = [];

  for (let i = 0; i < count; i += 1) {
    const bucket = pickBucket(rng());
    const start = performance.now();
    let path: string;
    let method = "GET";
    let init: RequestInit | undefined;

    switch (bucket) {
      case "success": {
        const id = ids.validIds[Math.floor(rng() * ids.validIds.length)];
        path = `/orders/${id}`;
        break;
      }
      case "not_found": {
        path = `/orders/${9_000_000 + i}`;
        break;
      }
      case "slow": {
        const id = ids.validIds[Math.floor(rng() * ids.validIds.length)];
        path = `/orders/${id}?slow=1`;
        break;
      }
      case "error": {
        const id = ids.guestIds[Math.floor(rng() * ids.guestIds.length)];
        path = `/orders/${id}`;
        break;
      }
      case "created": {
        path = "/orders";
        method = "POST";
        init = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customerEmail: `traffic-${i}@example.com`, amountCents: 1000 + i }),
        };
        break;
      }
    }

    const response = await fetch(`${baseUrl}${path}`, init);
    await response.text();
    const clientDurationMs = performance.now() - start;
    results.push({ bucket, method, path, statusCode: response.status, clientDurationMs });
  }

  return results;
}

export function summarizeTraffic(results: TrafficResult[]): TrafficMixCounts {
  return {
    fast: results.filter((r) => r.bucket === "success").length,
    notFound: results.filter((r) => r.bucket === "not_found").length,
    slow: results.filter((r) => r.bucket === "slow").length,
    error: results.filter((r) => r.bucket === "error").length,
    create: results.filter((r) => r.bucket === "created").length,
  };
}
