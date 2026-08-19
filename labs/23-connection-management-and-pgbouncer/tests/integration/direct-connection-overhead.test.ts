import { describe, it, expect } from "vitest";
import { runDirectConnectionOverhead } from "../../src/scenarios/direct-connection-overhead.js";

describe("direct connections exhaust Postgres's max_connections", () => {
  it("rejects a meaningful fraction of attempts once concurrency exceeds max_connections", async () => {
    // 45 concurrent direct connections against this lab's configured
    // max_connections=30 (see .env.example). A relative assertion, not an
    // exact rejection count: the precise number of successes depends on
    // exactly how many connections Postgres was already using (other test
    // files, monitoring connections) at the instant this burst started.
    const concurrentConnections = 45;
    const summary = await runDirectConnectionOverhead(concurrentConnections, 250);

    expect(summary.succeeded).toBeLessThan(concurrentConnections);
    expect(summary.tooManyClientsAlready).toBeGreaterThan(0);
  }, 30_000);
});
