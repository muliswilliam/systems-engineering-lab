import { describe, it, expect } from "vitest";
import { runSessionVsTransactionScenario } from "../../src/scenarios/session-pooling-vs-transaction-pooling.js";

describe("session-state preservation differs between pool modes", () => {
  it("session pooling always preserves SET application_name; transaction pooling does not reliably", async () => {
    const summary = await runSessionVsTransactionScenario(4, 20);

    expect(summary.sessionPreservedCount).toBe(summary.sessionTrials.length);
    expect(summary.transactionPreservedCount).toBeLessThan(summary.transactionTrials.length);
  }, 60_000);
});
