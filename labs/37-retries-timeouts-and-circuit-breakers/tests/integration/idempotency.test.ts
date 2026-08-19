import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UnreliableDownstream } from "../../src/downstream/unreliable-downstream.js";
import { TimeoutError, withTimeout } from "../../src/lib/timeout.js";

const CLIENT_TIMEOUT_MS = 100; // shorter than the downstream's slow (400-900ms) response
const AMOUNT_CENTS = 2_500;

describe("idempotency: caller timeout races a slow-but-successful downstream charge", () => {
  it("NAIVE retry (no reused idempotency key) really does double-charge the ledger", async () => {
    const downstream = new UnreliableDownstream({ seed: 5, health: "healthy" });

    await expect(withTimeout(() => downstream.charge(AMOUNT_CENTS), CLIENT_TIMEOUT_MS)).rejects.toBeInstanceOf(
      TimeoutError,
    );
    // The charge already committed server-side even though the caller saw a timeout.
    expect(downstream.ledgerTotal).toBe(AMOUNT_CENTS);

    // Naive retry: no idempotency key at all.
    await withTimeout(() => downstream.charge(AMOUNT_CENTS), 2_000);

    expect(downstream.ledgerTotal).toBe(AMOUNT_CENTS * 2);
    expect(downstream.chargesApplied).toBe(2);
  });

  it("FIXED retry (idempotency key reused) charges exactly once", async () => {
    const downstream = new UnreliableDownstream({ seed: 6, health: "healthy" });
    const idempotencyKey = randomUUID();

    await expect(
      withTimeout(() => downstream.charge(AMOUNT_CENTS, idempotencyKey), CLIENT_TIMEOUT_MS),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(downstream.ledgerTotal).toBe(AMOUNT_CENTS);

    const retryResult = await withTimeout(() => downstream.charge(AMOUNT_CENTS, idempotencyKey), 2_000);

    expect(downstream.ledgerTotal).toBe(AMOUNT_CENTS); // unchanged - NOT double-charged
    expect(downstream.chargesApplied).toBe(1);
    expect(downstream.uniqueChargeCount).toBe(1);
    expect(retryResult.chargeId).toBe("ch_1"); // the retry got back the ORIGINAL charge
  });

  it("a fresh idempotency key per retry provides NO protection, same as no key at all", async () => {
    const downstream = new UnreliableDownstream({ seed: 8, health: "healthy" });

    await expect(
      withTimeout(() => downstream.charge(AMOUNT_CENTS, randomUUID()), CLIENT_TIMEOUT_MS),
    ).rejects.toBeInstanceOf(TimeoutError);

    // Buggy client: generates a NEW key on retry instead of reusing the original.
    await withTimeout(() => downstream.charge(AMOUNT_CENTS, randomUUID()), 2_000);

    expect(downstream.ledgerTotal).toBe(AMOUNT_CENTS * 2);
    expect(downstream.chargesApplied).toBe(2);
  });
});
