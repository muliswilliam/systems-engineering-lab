import { describe, it, expect } from "vitest";
import { runTransactionPoolingScenario } from "../../src/scenarios/pgbouncer-transaction-pooling.js";
import { getDefaultPoolSize } from "../../src/db/pgbouncer-admin.js";
import { transactionPoolingConnectionString } from "../../src/db/connections.js";

describe("pgbouncer transaction pooling multiplexes many clients onto few real backends", () => {
  it("succeeds for every client while using far fewer real Postgres backends than clients", async () => {
    const poolSize = await getDefaultPoolSize(transactionPoolingConnectionString());
    // Deliberately more concurrent clients than the pool's real backend
    // budget, and more than Postgres's own max_connections=30 would allow if
    // each one opened a direct connection instead.
    const concurrentClients = poolSize * 4;

    const summary = await runTransactionPoolingScenario(concurrentClients, 60);

    expect(summary.succeeded).toBe(concurrentClients);
    // The real, structural fact this lab is teaching: peak real backend
    // usage stays at or below the configured pool size, and clearly below
    // the number of concurrent clients.
    expect(summary.peakConcurrentBackends).toBeLessThanOrEqual(poolSize);
    expect(summary.peakConcurrentBackends).toBeLessThan(concurrentClients);
    expect(summary.distinctBackendPidCount).toBeLessThanOrEqual(poolSize);
  }, 30_000);
});
