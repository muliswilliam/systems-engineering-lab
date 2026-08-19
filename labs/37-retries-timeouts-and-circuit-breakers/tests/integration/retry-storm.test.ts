import { describe, expect, it } from "vitest";
import { runConcurrently } from "@labs/test-utils";
import { UnreliableDownstream } from "../../src/downstream/unreliable-downstream.js";

/**
 * Asserts the EXACT amplification number CLAUDE.md's brief calls for: 50
 * concurrent callers x 5 naive retries with no backoff against a downstream
 * that is fully down produces exactly 250 total downstream calls - not "some
 * larger number", the precise number.
 */
describe("naive retry storm (no backoff, no circuit breaker)", () => {
  const CALLERS = 50;
  const ATTEMPTS_PER_CALLER = 5;

  it("amplifies 50 concurrent callers into exactly 250 downstream calls", async () => {
    const downstream = new UnreliableDownstream({ seed: 1, health: "down-fail-fast" });

    await runConcurrently(CALLERS, async (callerId) => {
      for (let attempt = 1; attempt <= ATTEMPTS_PER_CALLER; attempt++) {
        try {
          await downstream.call(`caller-${callerId}`);
          return;
        } catch {
          // naive: immediately retry, no backoff, no restraint
        }
      }
    });

    expect(downstream.totalCallCount).toBe(CALLERS * ATTEMPTS_PER_CALLER);
    expect(downstream.totalCallCount).toBe(250);
  });

  it("every single one of those calls fails - the amplification buys zero successful requests", async () => {
    const downstream = new UnreliableDownstream({ seed: 2, health: "down-fail-fast" });
    let successCount = 0;

    await runConcurrently(CALLERS, async (callerId) => {
      for (let attempt = 1; attempt <= ATTEMPTS_PER_CALLER; attempt++) {
        try {
          await downstream.call(`caller-${callerId}`);
          successCount++;
          return;
        } catch {
          // expected - downstream is fully down
        }
      }
    });

    expect(successCount).toBe(0);
    expect(downstream.totalCallCount).toBe(250);
  });
});
