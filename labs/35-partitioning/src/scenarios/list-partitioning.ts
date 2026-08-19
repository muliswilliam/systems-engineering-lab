import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createLogger } from "@labs/logging";
import { createPool, waitForDatabase } from "@labs/db-utils";
import { explain } from "./partition-lib.js";
import { LIST_DEMO_TABLE as TABLE, resetListDemoTable } from "../db/partitions.js";

const log = createLogger("lab35:scenario:list-partitioning");

/**
 * Point 5 (optional): LIST partitioning as a contrast to RANGE. Same
 * mechanism, different kind of key - a fixed/slowly-growing set of discrete
 * category values (region) instead of a continuous range (time). This also
 * doubles as the one place in this lab that demonstrates the DEFAULT
 * partition escape hatch end to end (the main RANGE table deliberately has
 * none - see attach-and-missing-partition.ts).
 *
 * This scenario is self-contained: it seeds its own tiny dataset directly
 * (a handful of rows is enough to prove pruning and the missing-partition
 * error; this is a mechanism demo, not a performance benchmark) and resets
 * `metric_events_by_region` back to its as-migrated state (3 regions, no
 * DEFAULT) at the start of every run via the same `resetListDemoTable`
 * helper `pnpm seed` uses, so it is safe to re-run repeatedly and a fresh
 * `pnpm seed` also cleans up after it.
 */

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set - copy .env.example to .env first");
  }
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  await waitForDatabase(pool);

  log.info({}, "--- Point 5: LIST partitioning by a discrete column (region) instead of RANGE by time ---");

  await resetListDemoTable(pool);
  await pool.query(
    `INSERT INTO ${TABLE} (region, device_id, metric, value, recorded_at) VALUES
      ('us', 'dev-0001', 'temperature_c', 21.0, now()),
      ('us', 'dev-0002', 'temperature_c', 22.0, now()),
      ('eu', 'dev-0101', 'temperature_c', 18.5, now()),
      ('apac', 'dev-0201', 'temperature_c', 29.0, now())`,
  );
  log.info({ regions: ["us", "eu", "apac"] }, "seeded 4 rows across the 3 existing LIST partitions");

  const plan = await explain(pool, `SELECT * FROM ${TABLE} WHERE region = $1`, ["us"]);
  log.warn(
    {
      relationsScanned: plan.relationsScanned,
      partitionsTouched: plan.relationsScanned.filter((r) => r.startsWith(`${TABLE}_`)).length,
      totalPartitionsThatExist: 3,
    },
    "LIST pruning: WHERE region = 'us' touches only the 'us' partition, exactly like RANGE pruning touched only the matching month",
  );

  // Missing-partition error - the SAME class of failure RANGE partitioning
  // has, for the SAME underlying reason: 'latam' is not IN any partition's
  // value list, and there is no DEFAULT partition (yet).
  let captured: { code?: string; message?: string } | undefined;
  try {
    await pool.query(`INSERT INTO ${TABLE} (region, device_id, metric, value, recorded_at) VALUES ('latam', 'dev-0301', 'temperature_c', 27.0, now())`);
  } catch (error) {
    const pgError = error as { code?: string; message?: string };
    captured = { code: pgError.code, message: pgError.message };
  }
  log.warn(
    { postgresErrorCode: captured?.code, message: captured?.message },
    "REAL CAPTURED FAILURE: 'latam' has no matching LIST partition and there is no DEFAULT partition - same failure class as RANGE, different key type",
  );

  // Fix: attach a DEFAULT partition - the escape hatch this lab deliberately
  // did NOT use on the main RANGE table (see attach-and-missing-partition.ts
  // for why "provision ahead of time" is usually preferred to "catch
  // everything in a junk drawer" for a growing, well-known dimension like
  // months; DEFAULT is a better fit here because new regions are rarer and
  // less predictable than the next calendar month).
  await pool.query(`CREATE TABLE ${TABLE}_default PARTITION OF ${TABLE} DEFAULT`);
  log.info({}, "FIX: attached a DEFAULT partition to catch any region not explicitly listed");

  const { rows: insertedRows } = await pool.query<{ id: number; region: string }>(
    `INSERT INTO ${TABLE} (region, device_id, metric, value, recorded_at) VALUES ('latam', 'dev-0301', 'temperature_c', 27.0, now()) RETURNING id, region`,
  );
  log.warn(
    { insertedId: insertedRows[0]!.id, region: insertedRows[0]!.region },
    "RETRY SUCCEEDED: the same insert now lands in the DEFAULT partition",
  );

  // Confirm the DEFAULT partition does NOT cost 'us'-filtered queries
  // anything - Postgres can still prove a literal 'us' cannot live in
  // DEFAULT (since 'us' already has its own explicit partition), so pruning
  // still excludes DEFAULT along with 'eu' and 'apac'.
  const planAfterDefault = await explain(pool, `SELECT * FROM ${TABLE} WHERE region = $1`, ["us"]);
  log.warn(
    { relationsScanned: planAfterDefault.relationsScanned },
    "Even WITH a DEFAULT partition present, a literal region = 'us' filter still prunes to just the 'us' partition - Postgres can prove DEFAULT cannot contain a value that already has its own explicit partition",
  );

  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    log.error({ err: error }, "list partitioning scenario failed");
    process.exit(1);
  });
}
