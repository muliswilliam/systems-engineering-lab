import { describe, expect, it } from "vitest";
import {
  NonTransientDownstreamError,
  TransientDownstreamError,
  UnreliableDownstream,
} from "../../src/downstream/unreliable-downstream.js";

describe("UnreliableDownstream determinism", () => {
  it("produces the exact same sequence of outcomes for the same seed (deterministic failure injection)", async () => {
    async function runSequence(): Promise<string[]> {
      const downstream = new UnreliableDownstream({ seed: 4242, health: "degraded" });
      const outcomes: string[] = [];
      for (let i = 0; i < 10; i++) {
        try {
          await downstream.call(`req-${i}`);
          outcomes.push("success");
        } catch (err) {
          outcomes.push(err instanceof TransientDownstreamError ? "transient" : "non-transient");
        }
      }
      return outcomes;
    }

    const first = await runSequence();
    const second = await runSequence();
    expect(second).toEqual(first);
    // Sanity: a "degraded" downstream over 10 calls should not be ALL one outcome.
    expect(new Set(first).size).toBeGreaterThan(1);
  });

  it("down-fail-fast always throws TransientDownstreamError, never succeeds", async () => {
    const downstream = new UnreliableDownstream({ seed: 1, health: "down-fail-fast" });
    for (let i = 0; i < 5; i++) {
      await expect(downstream.call(`req-${i}`)).rejects.toBeInstanceOf(TransientDownstreamError);
    }
  });

  it("healthy always succeeds", async () => {
    const downstream = new UnreliableDownstream({ seed: 1, health: "healthy" });
    for (let i = 0; i < 5; i++) {
      await expect(downstream.call(`req-${i}`)).resolves.toMatchObject({ ok: true });
    }
  });

  it("setHealth changes behavior for subsequent calls only", async () => {
    const downstream = new UnreliableDownstream({ seed: 1, health: "down-fail-fast" });
    await expect(downstream.call("before")).rejects.toBeInstanceOf(TransientDownstreamError);
    downstream.setHealth("healthy");
    await expect(downstream.call("after")).resolves.toMatchObject({ ok: true });
  });

  it("charge() with no idempotency key always applies a new effect", async () => {
    const downstream = new UnreliableDownstream({ seed: 1, health: "healthy" });
    await downstream.charge(100);
    await downstream.charge(100);
    expect(downstream.ledgerTotal).toBe(200);
    expect(downstream.uniqueChargeCount).toBe(0); // no key => nothing tracked for dedup
  });

  it("a non-transient error is a distinct type from a transient one", () => {
    expect(new NonTransientDownstreamError()).not.toBeInstanceOf(TransientDownstreamError);
    expect(new TransientDownstreamError()).not.toBeInstanceOf(NonTransientDownstreamError);
  });
});
