import { describe, expect, it } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../../src/lib/circuit-breaker.js";
import { UnreliableDownstream } from "../../src/downstream/unreliable-downstream.js";

describe("CircuitBreaker wrapping a real UnreliableDownstream", () => {
  it("trips OPEN after exactly the failure threshold and stops calling the downstream at all", async () => {
    const downstream = new UnreliableDownstream({ seed: 21, health: "down-fail-fast" });
    const breaker = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 10_000 });

    for (let i = 0; i < 5; i++) {
      await expect(breaker.execute(() => downstream.call(`c-${i}`))).rejects.toThrow();
    }
    expect(breaker.getState()).toBe("OPEN");
    expect(downstream.totalCallCount).toBe(5);

    // Three more calls while OPEN, well within the cooldown - none should
    // reach the downstream at all.
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(() => downstream.call(`should-not-run-${i}`))).rejects.toBeInstanceOf(
        CircuitOpenError,
      );
    }
    expect(downstream.totalCallCount).toBe(5); // unchanged - fast-failed, not attempted
  });

  it("rejects OPEN calls near-instantly, in contrast to a real downstream call's measured latency", async () => {
    const downstream = new UnreliableDownstream({
      seed: 22,
      health: "down-fail-fast",
      fastLatencyRangeMs: [20, 20],
    });
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });

    const startedAtFirst = Date.now();
    await expect(breaker.execute(() => downstream.call("first"))).rejects.toThrow();
    const firstCallLatencyMs = Date.now() - startedAtFirst;
    expect(breaker.getState()).toBe("OPEN");

    const startedAtSecond = Date.now();
    await expect(breaker.execute(() => downstream.call("second"))).rejects.toBeInstanceOf(CircuitOpenError);
    const fastFailLatencyMs = Date.now() - startedAtSecond;

    // The real downstream call took ~20ms (its own configured latency); the
    // fast-fail took under 5ms - a real, measured order-of-magnitude gap.
    expect(firstCallLatencyMs).toBeGreaterThanOrEqual(15);
    expect(fastFailLatencyMs).toBeLessThan(15);
  });

  it("HALF_OPEN probe success closes the breaker and allows exactly one downstream call", async () => {
    const downstream = new UnreliableDownstream({ seed: 23, health: "down-fail-fast" });
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 30 });

    await expect(breaker.execute(() => downstream.call("fails"))).rejects.toThrow();
    expect(breaker.getState()).toBe("OPEN");

    downstream.setHealth("healthy");
    await new Promise((resolve) => setTimeout(resolve, 40)); // real cooldown elapse

    const callsBefore = downstream.totalCallCount;
    await breaker.execute(() => downstream.call("probe"));
    expect(breaker.getState()).toBe("CLOSED");
    expect(downstream.totalCallCount - callsBefore).toBe(1);
  });
});
