import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { runChoreographedOrderSaga } from "../../src/choreography/run.js";
import { runOrderSaga } from "../../src/orchestration/orchestrator.js";
import { getSagaLogSummary } from "../../src/scenarios/query-helpers.js";
import { resetDatabase } from "./catalog-helpers.js";

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await resetDatabase();
});

afterAll(async () => {
  await pool.end();
});

/**
 * The observability half of this lab's thesis: for the IDENTICAL business
 * outcome, choreography's `saga_log` requires strictly more rows and more
 * distinct actors to reconstruct than orchestration's - a real, measured
 * indirection cost, not a hand-waved one. See README "Observe" for the
 * exact numbers captured during this lab's own validation run.
 */
describe("saga_log observability: choreography is measurably harder to trace than orchestration", () => {
  it("happy path: choreography produces more log rows and more distinct actors for the same outcome", async () => {
    const orchestrated = await runOrderSaga(pool, {
      customerName: "Observability Happy Orchestrated",
      amountCents: 1_000,
      itemSku: "TEST-SKU-A",
      quantity: 1,
    });
    const choreographed = await runChoreographedOrderSaga(pool, {
      customerName: "Observability Happy Choreographed",
      amountCents: 1_000,
      itemSku: "TEST-SKU-A",
      quantity: 1,
    });

    const orchestratedSummary = await getSagaLogSummary(pool, orchestrated.orderId!, "orchestration");
    const choreographedSummary = await getSagaLogSummary(pool, choreographed.orderId!, "choreography");

    // Orchestration: one coordinator, so no separate "actor" is ever named
    // in saga_log.detail (it IS the single source of every log line).
    expect(orchestratedSummary.distinctActors).toHaveLength(0);
    // Choreography: at least the 4 named services must appear.
    expect(choreographedSummary.distinctActors.length).toBeGreaterThanOrEqual(4);

    expect(choreographedSummary.entryCount).toBeGreaterThan(orchestratedSummary.entryCount);
    expect(choreographedSummary.distinctActors.length).toBeGreaterThan(orchestratedSummary.distinctActors.length);
  });

  it("failure and compensation: choreography still produces more log rows and more distinct actors", async () => {
    const orchestrated = await runOrderSaga(
      pool,
      { customerName: "Observability Failure Orchestrated", amountCents: 2_000, itemSku: "TEST-SKU-B", quantity: 1 },
      { failAtStep: "createShipment" },
    );
    const choreographed = await runChoreographedOrderSaga(
      pool,
      { customerName: "Observability Failure Choreographed", amountCents: 2_000, itemSku: "TEST-SKU-B", quantity: 1 },
      { failAtStep: "createShipment" },
    );

    const orchestratedSummary = await getSagaLogSummary(pool, orchestrated.orderId!, "orchestration");
    const choreographedSummary = await getSagaLogSummary(pool, choreographed.orderId!, "choreography");

    expect(choreographedSummary.entryCount).toBeGreaterThan(orchestratedSummary.entryCount);
    expect(choreographedSummary.distinctActors.length).toBeGreaterThan(orchestratedSummary.distinctActors.length);

    // Reconstructing the choreography failure trace requires following the
    // full compensation chain: shipment-service -> payment-service ->
    // inventory-service -> order-service.
    expect(choreographedSummary.distinctActors).toEqual(
      expect.arrayContaining(["inventory-service", "order-service", "payment-service", "shipment-service"]),
    );
  });
});
