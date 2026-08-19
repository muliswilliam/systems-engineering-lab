/**
 * A real CLOSED -> OPEN -> HALF_OPEN -> CLOSED/OPEN state machine, reused
 * fresh from Lab 37's own `src/lib/circuit-breaker.ts` (independent copy).
 * While OPEN, `execute()` rejects WITHOUT ever invoking `fn` - the point is
 * to stop hammering a struggling downstream, not merely to fail fast on our
 * own account. See README "Why the fix works" for why this is the piece
 * that stops a duplicate-order pile-up from also becoming a downstream
 * pile-up.
 */
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitOpenError extends Error {
  constructor(state: CircuitState) {
    super(`circuit breaker is ${state} - call rejected without attempting the downstream`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
  onStateChange?: (from: CircuitState, to: CircuitState, info: Record<string, unknown>) => void;
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
