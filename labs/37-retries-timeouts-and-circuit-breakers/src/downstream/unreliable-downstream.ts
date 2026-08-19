import { mulberry32, sleep } from "../lib/random.js";

/**
 * A REAL simulated unreliable downstream (an in-process async function, not a
 * mock that just returns canned values) - see this lab's README
 * "Architecture" for why this is preferred over a small local HTTP server
 * (no measurable difference for the concepts being taught, and it keeps the
 * lab dependency-free and instant to start).
 *
 * `health` controls what kind of trouble every call has:
 *
 * - `healthy`        - fast, reliable success.
 * - `degraded`       - a realistic mix of fast success / slow success /
 *                       transient error / non-transient error, seeded so the
 *                       exact sequence is reproducible.
 * - `down-fail-fast` - every call fails immediately with a transient error
 *                       (models a downstream that is down but at least says
 *                       so right away - e.g. connection refused).
 * - `down-hang`      - every call hangs for `hangMs` before EVENTUALLY
 *                       succeeding (models a downstream that is overloaded
 *                       rather than actually crashed - the request queues up
 *                       and is eventually served, long after any reasonable
 *                       caller has given up).
 */
export type DownstreamHealth = "healthy" | "degraded" | "down-fail-fast" | "down-hang";

export class TransientDownstreamError extends Error {
  constructor(message = "downstream temporarily unavailable") {
    super(message);
    this.name = "TransientDownstreamError";
  }
}

export class NonTransientDownstreamError extends Error {
  constructor(message = "request rejected by downstream (not retryable)") {
    super(message);
    this.name = "NonTransientDownstreamError";
  }
}

export interface UnreliableDownstreamOptions {
  seed: number;
  health: DownstreamHealth;
  /** Fraction of `degraded` calls that fail with a transient error. */
  transientErrorRate?: number;
  /** Fraction of `degraded` calls that fail with a non-transient error. */
  nonTransientErrorRate?: number;
  /** Fraction of `degraded` calls that succeed, but slowly. */
  slowRate?: number;
  fastLatencyRangeMs?: [number, number];
  slowLatencyRangeMs?: [number, number];
  /** How long a `down-hang` call takes to eventually settle. */
  hangMs?: number;
}

export interface CallLogEntry {
  atMs: number;
  label: string;
  idempotencyKey?: string;
}

export interface ChargeResult {
  chargeId: string;
  amountCents: number;
  idempotencyKey: string | undefined;
}

const DEFAULTS = {
  transientErrorRate: 0.45,
  nonTransientErrorRate: 0.1,
  slowRate: 0.15,
  fastLatencyRangeMs: [5, 30] as [number, number],
  slowLatencyRangeMs: [400, 900] as [number, number],
  hangMs: 5_000,
};

export class UnreliableDownstream {
  readonly callLog: CallLogEntry[] = [];
  private random: () => number;
  private ledgerTotalCents = 0;
  private chargeCounter = 0;
  /** Models the downstream's OWN idempotency-key ledger, e.g. Stripe's. */
  private readonly appliedCharges = new Map<string, ChargeResult>();

  constructor(private opts: UnreliableDownstreamOptions) {
    this.random = mulberry32(opts.seed);
  }

  get totalCallCount(): number {
    return this.callLog.length;
  }

  get ledgerTotal(): number {
    return this.ledgerTotalCents;
  }

  /** How many times the LEDGER was actually charged (a new effect applied), regardless of key. */
  get chargesApplied(): number {
    return this.chargeCounter;
  }

  /** How many DISTINCT idempotency keys have an applied charge (only meaningful when keys are used). */
  get uniqueChargeCount(): number {
    return this.appliedCharges.size;
  }

  setHealth(health: DownstreamHealth): void {
    this.opts.health = health;
  }

  private pickLatency(kind: "fast" | "slow"): number {
    const [min, max] =
      kind === "fast"
        ? (this.opts.fastLatencyRangeMs ?? DEFAULTS.fastLatencyRangeMs)
        : (this.opts.slowLatencyRangeMs ?? DEFAULTS.slowLatencyRangeMs);
    return min + this.random() * (max - min);
  }

  private async settleGeneric(label: string): Promise<{ ok: true; latencyMs: number }> {
    const health = this.opts.health;

    if (health === "healthy") {
      const latencyMs = this.pickLatency("fast");
      await sleep(latencyMs);
      return { ok: true, latencyMs };
    }

    if (health === "down-fail-fast") {
      const latencyMs = this.pickLatency("fast");
      await sleep(latencyMs);
      throw new TransientDownstreamError(`downstream is down (call: ${label})`);
    }

    if (health === "down-hang") {
      const hangMs = this.opts.hangMs ?? DEFAULTS.hangMs;
      await sleep(hangMs);
      return { ok: true, latencyMs: hangMs };
    }

    // degraded
    const transientRate = this.opts.transientErrorRate ?? DEFAULTS.transientErrorRate;
    const nonTransientRate = this.opts.nonTransientErrorRate ?? DEFAULTS.nonTransientErrorRate;
    const slowRate = this.opts.slowRate ?? DEFAULTS.slowRate;
    const r = this.random();

    if (r < transientRate) {
      const latencyMs = this.pickLatency("fast");
      await sleep(latencyMs);
      throw new TransientDownstreamError(`downstream returned a transient error (call: ${label})`);
    }
    if (r < transientRate + nonTransientRate) {
      const latencyMs = this.pickLatency("fast");
      await sleep(latencyMs);
      throw new NonTransientDownstreamError(`downstream rejected the request (call: ${label})`);
    }
    if (r < transientRate + nonTransientRate + slowRate) {
      const latencyMs = this.pickLatency("slow");
      await sleep(latencyMs);
      return { ok: true, latencyMs };
    }
    const latencyMs = this.pickLatency("fast");
    await sleep(latencyMs);
    return { ok: true, latencyMs };
  }

  /** Generic call used by the timeout / retry-storm / backoff / circuit-breaker scenarios. */
  async call(label: string): Promise<{ ok: true; latencyMs: number }> {
    this.callLog.push({ atMs: Date.now(), label });
    return this.settleGeneric(label);
  }

  /**
   * A simulated "charge card" downstream call, used only by the idempotency
   * scenario. Modeled directly on a real payment processor: the LEDGER WRITE
   * happens immediately and durably; only the RESPONSE is slow. If a caller's
   * own timeout fires before that slow response arrives, the caller cannot
   * tell "it failed" from "it succeeded but I gave up waiting" - see README
   * "Scenario".
   *
   * When `idempotencyKey` is provided and has been seen before, this method
   * returns the ORIGINAL result without charging the ledger again - the same
   * mechanism Lab 15 (`idempotency-and-deduplication`) implements with a
   * Postgres `UNIQUE` constraint + `INSERT ... ON CONFLICT DO NOTHING
   * RETURNING *`. Here it is a plain in-process `Map` instead, since this lab
   * has no database - see this lab's README "Fix it" for why that
   * substitution is fine for teaching the concept but NOT fine as a
   * production implementation (a `Map` is neither durable nor safe to share
   * across multiple server instances).
   */
  async charge(amountCents: number, idempotencyKey?: string): Promise<ChargeResult> {
    this.callLog.push({ atMs: Date.now(), label: "charge", idempotencyKey });

    if (idempotencyKey) {
      const existing = this.appliedCharges.get(idempotencyKey);
      if (existing) {
        // Retry recognized: return the cached result, do NOT touch the ledger.
        await sleep(this.pickLatency("fast"));
        return existing;
      }
    }

    // The side effect commits durably right here, synchronously with respect
    // to the rest of this function - a real payment processor's database
    // write is exactly this: done before the HTTP response is even built.
    this.chargeCounter++;
    this.ledgerTotalCents += amountCents;
    const result: ChargeResult = {
      chargeId: `ch_${this.chargeCounter}`,
      amountCents,
      idempotencyKey,
    };
    if (idempotencyKey) {
      this.appliedCharges.set(idempotencyKey, result);
    }

    // The RESPONSE is slow - long enough that a caller with a short timeout
    // will give up before it arrives, even though the charge already happened.
    await sleep(this.pickLatency("slow"));
    return result;
  }
}
