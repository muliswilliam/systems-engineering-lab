import { mulberry32, sleep } from "../lib/random.js";

/**
 * A real, seeded, deterministic-but-realistic simulated notification
 * provider (order-confirmation email/SMS) - the "external-ish dependency"
 * SPEC.md Lab 37/40 both call for. Modeled after Lab 37's own
 * `UnreliableDownstream` (independent copy, same health-mode shape) rather
 * than imported from it, per the independent-labs principle.
 *
 * `health` controls what every call experiences:
 *   - `healthy`  - fast, reliable success.
 *   - `degraded` - a realistic mix of fast success / slow success /
 *                  transient failure, seeded so the exact sequence is
 *                  reproducible across repeated runs of the same scenario.
 *   - `down`     - every call fails after a short delay (models an outage
 *                  the downstream at least reports quickly, e.g. a 5xx).
 *
 * `callLog` records every attempt, including the caller-supplied
 * `dedupeKey` (this lab passes the order's own idempotency key) - the
 * composed scenario's central measurement, "how many times did we actually
 * try to notify the customer for ONE logical order," is read straight off
 * this log, not inferred.
 */
export type NotificationHealth = "healthy" | "degraded" | "down";

export class TransientNotificationError extends Error {
  constructor(message = "notification provider temporarily unavailable") {
    super(message);
    this.name = "TransientNotificationError";
  }
}

export interface NotificationCallLogEntry {
  atMs: number;
  dedupeKey: string;
  outcome: "success" | "failure";
  latencyMs: number;
}

export interface NotificationServiceOptions {
  seed: number;
  health: NotificationHealth;
  transientErrorRate?: number;
  slowRate?: number;
  fastLatencyRangeMs?: [number, number];
  slowLatencyRangeMs?: [number, number];
}

const DEFAULTS = {
  transientErrorRate: 0.55,
  slowRate: 0.25,
  fastLatencyRangeMs: [5, 25] as [number, number],
  slowLatencyRangeMs: [300, 700] as [number, number],
};

export class NotificationService {
  readonly callLog: NotificationCallLogEntry[] = [];
  private random: () => number;

  constructor(private opts: NotificationServiceOptions) {
    this.random = mulberry32(opts.seed);
  }

  get totalCallCount(): number {
    return this.callLog.length;
  }

  /** Distinct logical orders actually notified (by dedupe key) - the number that matters to the customer. */
  get distinctKeysNotified(): number {
    return new Set(this.callLog.filter((e) => e.outcome === "success").map((e) => e.dedupeKey)).size;
  }

  setHealth(health: NotificationHealth): void {
    this.opts.health = health;
  }

  private pickLatency(kind: "fast" | "slow"): number {
    const [min, max] =
      kind === "fast"
        ? (this.opts.fastLatencyRangeMs ?? DEFAULTS.fastLatencyRangeMs)
        : (this.opts.slowLatencyRangeMs ?? DEFAULTS.slowLatencyRangeMs);
    return min + this.random() * (max - min);
  }

  /**
   * Sends one order-confirmation notification. `dedupeKey` is recorded for
   * measurement only - this simulated provider does NOT itself deduplicate
   * (a real one might, but this lab's own protection against duplicate
   * sends is upstream: idempotent checkout means only one outbox event, and
   * therefore only one call, ever exists per logical order - see README
   * "Why the fix works").
   */
  async send(dedupeKey: string): Promise<{ ok: true; latencyMs: number }> {
    const health = this.opts.health;

    if (health === "healthy") {
      const latencyMs = this.pickLatency("fast");
      await sleep(latencyMs);
      this.callLog.push({ atMs: Date.now(), dedupeKey, outcome: "success", latencyMs });
      return { ok: true, latencyMs };
    }

    if (health === "down") {
      const latencyMs = this.pickLatency("fast");
      await sleep(latencyMs);
      this.callLog.push({ atMs: Date.now(), dedupeKey, outcome: "failure", latencyMs });
      throw new TransientNotificationError("notification provider is down");
    }

    // degraded
    const transientRate = this.opts.transientErrorRate ?? DEFAULTS.transientErrorRate;
    const slowRate = this.opts.slowRate ?? DEFAULTS.slowRate;
    const r = this.random();

    if (r < transientRate) {
      const latencyMs = this.pickLatency("fast");
      await sleep(latencyMs);
      this.callLog.push({ atMs: Date.now(), dedupeKey, outcome: "failure", latencyMs });
      throw new TransientNotificationError();
    }
    if (r < transientRate + slowRate) {
      const latencyMs = this.pickLatency("slow");
      await sleep(latencyMs);
      this.callLog.push({ atMs: Date.now(), dedupeKey, outcome: "success", latencyMs });
      return { ok: true, latencyMs };
    }
    const latencyMs = this.pickLatency("fast");
    await sleep(latencyMs);
    this.callLog.push({ atMs: Date.now(), dedupeKey, outcome: "success", latencyMs });
    return { ok: true, latencyMs };
  }
}
