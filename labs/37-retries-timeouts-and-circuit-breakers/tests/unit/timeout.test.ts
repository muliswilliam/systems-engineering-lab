import { describe, expect, it } from "vitest";
import { TimeoutError, withTimeout } from "../../src/lib/timeout.js";

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("withTimeout", () => {
  it("resolves with the function's value when it settles before the timeout", async () => {
    const result = await withTimeout(() => delay(10, "ok"), 200);
    expect(result).toBe("ok");
  });

  it("rejects with TimeoutError when the function takes longer than the timeout", async () => {
    await expect(withTimeout(() => delay(500, "too-slow"), 50)).rejects.toBeInstanceOf(TimeoutError);
  });

  it("bounds the caller's wait close to the configured timeout, not the underlying delay", async () => {
    const startedAt = Date.now();
    await expect(withTimeout(() => delay(5_000, "never-seen"), 50)).rejects.toBeInstanceOf(TimeoutError);
    const elapsedMs = Date.now() - startedAt;
    // Generous tolerance to avoid flakiness (CLAUDE.md: avoid fragile timing
    // assertions) while still proving the bound is real, not coincidental.
    expect(elapsedMs).toBeGreaterThanOrEqual(50);
    expect(elapsedMs).toBeLessThan(300);
  });

  it("propagates the underlying rejection when the function fails before the timeout", async () => {
    const boom = new Error("boom");
    await expect(
      withTimeout(() => Promise.reject(boom), 200),
    ).rejects.toBe(boom);
  });
});
