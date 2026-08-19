import type { Pool } from "pg";

/**
 * Canonical partition layout for `metric_events_partitioned` (see
 * drizzle/0001_create_partitioned_table.sql). Shared by seed.ts (to
 * reconcile the table back to this exact layout on every reseed, since
 * scenario scripts deliberately DETACH/DROP/ATTACH partitions to
 * demonstrate real operations) and by the scenario scripts themselves (so
 * they agree on names/bounds instead of re-deriving them ad hoc).
 */
export const PARTITIONED_YEAR = 2025;
export const PARTITIONED_TABLE = "metric_events_partitioned";

export interface MonthPartition {
  name: string;
  year: number;
  month: number; // 1-12
  /** Inclusive lower bound, UTC. */
  from: Date;
  /** Exclusive upper bound, UTC. */
  to: Date;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function monthPartitionName(year: number, month: number): string {
  return `metric_events_y${year}m${pad2(month)}`;
}

export function monthBounds(year: number, month: number): { from: Date; to: Date } {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = month === 12 ? new Date(Date.UTC(year + 1, 0, 1)) : new Date(Date.UTC(year, month, 1));
  return { from, to };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The 12 canonical monthly partitions for `PARTITIONED_YEAR`. */
export function canonicalPartitions(): MonthPartition[] {
  const partitions: MonthPartition[] = [];
  for (let month = 1; month <= 12; month += 1) {
    const { from, to } = monthBounds(PARTITIONED_YEAR, month);
    partitions.push({ name: monthPartitionName(PARTITIONED_YEAR, month), year: PARTITIONED_YEAR, month, from, to });
  }
  return partitions;
}

export interface ExistingPartition {
  name: string;
  /** Raw `pg_get_expr` bound text, e.g. "FOR VALUES FROM (...) TO (...)" or "DEFAULT". */
  bound: string;
}

/** Real system-catalog inspection (pg_inherits/pg_class), not application bookkeeping. */
export async function listExistingPartitions(pool: Pool, parentTable: string): Promise<ExistingPartition[]> {
  const { rows } = await pool.query<{ relname: string; bound: string }>(
    `
      SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = $1
      ORDER BY c.relname
    `,
    [parentTable],
  );
  return rows.map((r) => ({ name: r.relname, bound: r.bound }));
}

async function detachAndDrop(pool: Pool, parentTable: string, partitionName: string): Promise<void> {
  await pool.query(`ALTER TABLE ${parentTable} DETACH PARTITION ${partitionName}`);
  await pool.query(`DROP TABLE ${partitionName}`);
}

async function createMonthPartition(pool: Pool, parentTable: string, partition: MonthPartition): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${partition.name} PARTITION OF ${parentTable} FOR VALUES FROM ('${isoDate(partition.from)}') TO ('${isoDate(partition.to)}')`,
  );
}

/**
 * Restores `metric_events_partitioned` to EXACTLY the 12 canonical monthly
 * partitions for `PARTITIONED_YEAR` - no more, no less. Scenario scripts in
 * this lab deliberately leave the table in a non-canonical state (a
 * detached/dropped January, an ATTACHed 2026-01 partition, a DEFAULT
 * partition) to demonstrate real operations; this makes `pnpm seed`
 * genuinely idempotent regardless of what a previous scenario run left
 * behind, per CLAUDE.md's "a lab must support a clean, deterministic reset."
 */
export async function reconcileCanonicalPartitionLayout(pool: Pool): Promise<{ dropped: string[]; created: string[] }> {
  const canonical = canonicalPartitions();
  const canonicalNames = new Set(canonical.map((p) => p.name));

  const existing = await listExistingPartitions(pool, PARTITIONED_TABLE);
  const dropped: string[] = [];
  for (const partition of existing) {
    if (!canonicalNames.has(partition.name)) {
      await detachAndDrop(pool, PARTITIONED_TABLE, partition.name);
      dropped.push(partition.name);
    }
  }

  const existingNames = new Set(existing.map((p) => p.name));
  const created: string[] = [];
  for (const partition of canonical) {
    if (!existingNames.has(partition.name)) {
      await createMonthPartition(pool, PARTITIONED_TABLE, partition);
      created.push(partition.name);
    }
  }

  return { dropped, created };
}

export const LIST_DEMO_TABLE = "metric_events_by_region";
const LIST_DEMO_CANONICAL_PARTITIONS = ["metric_events_by_region_us", "metric_events_by_region_eu", "metric_events_by_region_apac"];

/**
 * Restores `metric_events_by_region` (the Point 5 LIST-partitioning demo
 * table) back to its as-migrated state: exactly the 3 canonical region
 * partitions, no DEFAULT partition, no data. Used by seed.ts (so a full
 * `pnpm seed` cleans up every scenario's mutations, not just the main RANGE
 * table's) and by list-partitioning.ts / missing-partition.test.ts so all
 * three agree on what "clean" means for this table.
 */
export async function resetListDemoTable(pool: Pool): Promise<void> {
  const existing = await listExistingPartitions(pool, LIST_DEMO_TABLE);
  for (const partition of existing) {
    if (!LIST_DEMO_CANONICAL_PARTITIONS.includes(partition.name)) {
      await detachAndDrop(pool, LIST_DEMO_TABLE, partition.name);
    }
  }
  await pool.query(`TRUNCATE TABLE ${LIST_DEMO_TABLE} RESTART IDENTITY`);
}
