import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, waitForDatabase } from "../../src/db/client.js";
import { LIST_DEMO_TABLE as LIST_TABLE, PARTITIONED_TABLE, reconcileCanonicalPartitionLayout, resetListDemoTable } from "../../src/db/partitions.js";

async function insertOutOfRangeRow() {
  return pool.query(
    `INSERT INTO ${PARTITIONED_TABLE} (device_id, metric, value, recorded_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    ["dev-0001", "temperature_c", 21.4, "2026-01-15T00:00:00Z"],
  );
}

beforeAll(async () => {
  await waitForDatabase(pool);
  await migrate(db, { migrationsFolder: "drizzle" });
  await reconcileCanonicalPartitionLayout(pool);
  await resetListDemoTable(pool);
}, 180_000);

afterAll(async () => {
  await reconcileCanonicalPartitionLayout(pool);
  await resetListDemoTable(pool);
  await pool.end();
});

describe("RANGE: inserting a row with no matching partition and no DEFAULT partition", () => {
  it("fails with a real captured Postgres error (23514, check_violation)", async () => {
    await expect(insertOutOfRangeRow()).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("no partition of relation"),
    });
  });

  it("succeeds once the missing partition is provisioned ahead of the data", async () => {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS metric_events_y2026m01 PARTITION OF ${PARTITIONED_TABLE} FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')`,
    );
    const { rows } = await insertOutOfRangeRow();
    expect(Number(rows[0]!.id)).toBeGreaterThan(0);

    const { rows: countRows } = await pool.query<{ count: string }>("SELECT count(*) FROM metric_events_y2026m01");
    expect(Number(countRows[0]!.count)).toBe(1);
  });
});

describe("LIST: the same failure class, a discrete category key instead of a date range", () => {
  it("fails with a real captured Postgres error (23514) for a region with no partition", async () => {
    await expect(
      pool.query(`INSERT INTO ${LIST_TABLE} (region, device_id, metric, value, recorded_at) VALUES ('latam', 'dev-0301', 'temperature_c', 27.0, now())`),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("no partition of relation"),
    });
  });

  it("succeeds once a DEFAULT partition is attached, and the row lands there", async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${LIST_TABLE}_default PARTITION OF ${LIST_TABLE} DEFAULT`);
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO ${LIST_TABLE} (region, device_id, metric, value, recorded_at) VALUES ('latam', 'dev-0301', 'temperature_c', 27.0, now()) RETURNING id`,
    );
    expect(Number(rows[0]!.id)).toBeGreaterThan(0);

    const { rows: countRows } = await pool.query<{ count: string }>(`SELECT count(*) FROM ${LIST_TABLE}_default`);
    expect(Number(countRows[0]!.count)).toBe(1);
  });
});
