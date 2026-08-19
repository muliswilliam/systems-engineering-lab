import { describe, it, expect } from "vitest";
import { runPoolSizeTuningScenario } from "../../src/scenarios/pool-size-tuning.js";

describe("pool size is a throughput/queueing tradeoff", () => {
  it("a larger pool completes the same concurrent burst no slower than a small pool", async () => {
    const summary = await runPoolSizeTuningScenario(30, 40, 2, 20);

    expect(summary.largePoolWallClockMs).toBeLessThan(summary.smallPoolWallClockMs);
  }, 40_000);
});
