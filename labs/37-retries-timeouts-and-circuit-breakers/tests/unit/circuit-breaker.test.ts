import { describe, expect, it } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../../src/lib/circuit-breaker.js";

class DownstreamError extends Error {}

/** A controllable fake clock so cooldown transitions are deterministic, not real-time. */
function fakeClock(startAt = 0): { now: () => number; advance: (ms: number) => void } {
  let current = startAt;
  return { now: () => current, advance: (ms: number) => (current += ms) };
}

describe("CircuitBreaker", () => {
  it("stays CLOSED and calls fn while failures are below the threshold", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 });
    let calls = 0;
    for (let i = 0; i < 2; i++) {
      await expect(
        breaker.execute(async () => {
          calls++;
          throw new DownstreamError();
        }),
      ).rejects.toBeInstanceOf(DownstreamError);
    }
    expect(breaker.getState()).toBe("CLOSED");
    expect(calls).toBe(2);
  });

  it("opens after EXACTLY the configured number of consecutive failures, not before", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 });
    const failingCall = () =>
      breaker.execute(async () => {
        throw new DownstreamError();
      });

    await expect(failingCall()).rejects.toBeInstanceOf(DownstreamError);
    expect(breaker.getState()).toBe("CLOSED");
    await expect(failingCall()).rejects.toBeInstanceOf(DownstreamError);
    expect(breaker.getState()).toBe("CLOSED");
    await expect(failingCall()).rejects.toBeInstanceOf(DownstreamError);
    expect(breaker.getState()).toBe("OPEN"); // 3rd consecutive failure trips it
  });

  it("rejects immediately without calling fn while OPEN and before cooldown elapses", async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, now: clock.now });
    await expect(breaker.execute(async () => { throw new DownstreamError(); })).rejects.toBeInstanceOf(DownstreamError);
    expect(breaker.getState()).toBe("OPEN");

    let fnCalled = false;
    clock.advance(500); // still within the 1000ms cooldown
    await expect(
      breaker.execute(async () => {
        fnCalled = true;
        return "should never run";
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fnCalled).toBe(false);
  });

  it("stays OPEN for the FULL configured cooldown, then allows a HALF_OPEN probe", async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, now: clock.now });
    await expect(breaker.execute(async () => { throw new DownstreamError(); })).rejects.toBeInstanceOf(DownstreamError);

    clock.advance(999);
    await expect(breaker.execute(async () => "recovered")).rejects.toBeInstanceOf(CircuitOpenError);
    expect(breaker.getState()).toBe("OPEN");

    clock.advance(2); // now past the 1000ms cooldown
    const result = await breaker.execute(async () => "recovered");
    expect(result).toBe("recovered");
    expect(breaker.getState()).toBe("CLOSED"); // successful probe closes the circuit
  });

  it("reopens when the HALF_OPEN probe itself fails", async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, now: clock.now });
    await expect(breaker.execute(async () => { throw new DownstreamError(); })).rejects.toBeInstanceOf(DownstreamError);
    clock.advance(1_000);

    await expect(
      breaker.execute(async () => {
        throw new DownstreamError("still down");
      }),
    ).rejects.toBeInstanceOf(DownstreamError);
    expect(breaker.getState()).toBe("OPEN");

    // The clock hasn't advanced again - a second call must still fast-fail,
    // proving the reopened state used a fresh cooldown window.
    await expect(breaker.execute(async () => "irrelevant")).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("only allows ONE concurrent probe through while HALF_OPEN", async () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, now: clock.now });
    await expect(breaker.execute(async () => { throw new DownstreamError(); })).rejects.toBeInstanceOf(DownstreamError);
    clock.advance(1_000);

    let releaseProbe: (() => void) | undefined;
    const probeGate = new Promise<void>((resolve) => (releaseProbe = resolve));
    const probePromise = breaker.execute(async () => {
      await probeGate;
      return "probe-result";
    });

    // A second call arrives while the first probe is still in flight.
    await expect(breaker.execute(async () => "second-caller")).rejects.toBeInstanceOf(CircuitOpenError);

    releaseProbe?.();
    await expect(probePromise).resolves.toBe("probe-result");
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("resets the consecutive-failure count after any success while CLOSED", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000 });
    await expect(breaker.execute(async () => { throw new DownstreamError(); })).rejects.toBeInstanceOf(DownstreamError);
    await expect(breaker.execute(async () => "ok")).resolves.toBe("ok");
    expect(breaker.getState()).toBe("CLOSED");

    // One more failure should NOT trip it - the earlier failure was reset by the success.
    await expect(breaker.execute(async () => { throw new DownstreamError(); })).rejects.toBeInstanceOf(DownstreamError);
    expect(breaker.getState()).toBe("CLOSED");
  });
});
