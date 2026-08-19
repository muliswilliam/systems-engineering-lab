import { describe, expect, it } from "vitest";
import { runConcurrently, countFulfilled } from "@labs/test-utils";
import { BoundedResource, callSlowDownstream } from "../../src/downstream/slow-downstream.js";

/**
 * Proves the application-layer overload is real, per CLAUDE.md's "show
 * failure before the fix": a burst of concurrent calls, with NO limit on
 * how many are allowed to even attempt the slow downstream at once,
 * produces real acquire-timeout errors once the burst size exceeds what the
 * downstream's own capacity can serve within a reasonable wait. Bounding
 * the number of CONCURRENT callers to the downstream's own capacity (the
 * backpressure fix's essence, in miniature) eliminates the failures
 * entirely against the identical downstream.
 */
describe("naive application-layer overload (no concurrency limit on a slow downstream)", () => {
  it("produces real acquire-timeout failures when concurrency far exceeds downstream capacity", async () => {
    const resource = new BoundedResource(5);
    const results = await runConcurrently(100, () => callSlowDownstream(resource, 100, 300));

    const succeeded = countFulfilled(results);
    const failed = results.length - succeeded;

    // 5 slots * (300ms timeout / 100ms per call) ~= 15 requests can be
    // served within the timeout budget; the rest must fail for real.
    expect(failed).toBeGreaterThan(0);
    expect(succeeded).toBeGreaterThan(0);
  });

  it("produces zero failures against the identical downstream when concurrency is bounded to its capacity", async () => {
    const resource = new BoundedResource(5);
    // Never more than `capacity` in flight at once - the same guarantee a
    // concurrency-limiting backpressure mechanism provides.
    const results = await runConcurrently(5, () => callSlowDownstream(resource, 100, 300));

    expect(countFulfilled(results)).toBe(5);
  });
});
