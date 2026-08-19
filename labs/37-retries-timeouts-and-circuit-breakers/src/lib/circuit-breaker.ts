/**
 * A real closed -> open -> half-open -> closed/open state machine, per this
 * lab's README. Distinguishing feature vs. plain retry logic: while OPEN, a
 * call is rejected WITHOUT EVER INVOKING `fn` - the point is to stop hammering
 * a downstream that is clearly down, not merely to fail fast on our own
 * account.
 */
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitOpenError extends Error {
  constructor(state: CircuitState) {
    super(`circuit breaker is ${state} - call rejected without attempting the downstream`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures (while CLOSED) needed to trip to OPEN. */
  failureThreshold: number;
  /** How long to stay OPEN before allowing a single HALF_OPEN probe. */
  cooldownMs: number;
  /** Injectable clock so tests don't need real sleeps to cross the cooldown. */
  now?: () => number;
  onStateChange?: (
    from: CircuitState,
    to: CircuitState,
    info: Record<string, unknown>,
  ) => void;
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenProbeInFlight = false;
  private readonly now: () => number;

  constructor(private readonly opts: CircuitBreakerOptions) {
    this.now = opts.now ?? Date.now;
  }

  getState(): CircuitState {
    return this.state;
  }

  private transition(to: CircuitState, info: Record<string, unknown>): void {
    const from = this.state;
    this.state = to;
    if (from !== to) {
      this.opts.onStateChange?.(from, to, info);
    }
  }

  /**
   * Runs `fn` through the breaker. `fn` should already be the FULLY composed
   * "one logical attempt" (e.g. timeout + retry-with-backoff) - see this
   * lab's `composed.ts` scenario and README "Tie it together" for why retries
   * belong INSIDE this call, not wrapped around it.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (this.now() - this.openedAt >= this.opts.cooldownMs) {
        this.transition("HALF_OPEN", { reason: "cooldown elapsed" });
      } else {
        throw new CircuitOpenError(this.state);
      }
    }

    if (this.state === "HALF_OPEN") {
      if (this.halfOpenProbeInFlight) {
        // Only ONE trial call is allowed through per half-open window.
        throw new CircuitOpenError(this.state);
      }
      this.halfOpenProbeInFlight = true;
      try {
        const result = await fn();
        this.consecutiveFailures = 0;
        this.transition("CLOSED", { reason: "probe succeeded" });
        return result;
      } catch (err) {
        this.openedAt = this.now();
        this.transition("OPEN", { reason: "probe failed" });
        throw err;
      } finally {
        this.halfOpenProbeInFlight = false;
      }
    }

    // CLOSED
    try {
      const result = await fn();
      this.consecutiveFailures = 0;
      return result;
    } catch (err) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.opts.failureThreshold) {
        this.openedAt = this.now();
        this.transition("OPEN", {
          reason: "failure threshold reached",
          consecutiveFailures: this.consecutiveFailures,
        });
      }
      throw err;
    }
  }
}
