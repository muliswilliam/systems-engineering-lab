import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { replicaPool, waitForDatabase } from "../../src/db/replica-client.js";

beforeAll(async () => {
  await waitForDatabase(replicaPool);
});

afterAll(async () => {
  await replicaPool.end();
});

describe("replica is read-only at the Postgres level", () => {
  it("reports pg_is_in_recovery() = true", async () => {
    const result = await replicaPool.query<{ pg_is_in_recovery: boolean }>("SELECT pg_is_in_recovery()");
    expect(result.rows[0]?.pg_is_in_recovery).toBe(true);
  });

  it("rejects a direct write attempt with a real Postgres error", async () => {
    await expect(
      replicaPool.query("INSERT INTO widgets (name, value) VALUES ($1, $2)", ["should-never-exist", 1]),
    ).rejects.toThrow(/read-only transaction/i);
  });
});
