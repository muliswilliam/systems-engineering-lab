import { pgTable, bigint, uuid, text, doublePrecision, timestamp, index } from "drizzle-orm/pg-core";

/**
 * `metric_events_flat` - a fresh, standalone, time-series-shaped table
 * modeling IoT device telemetry (temperature/humidity/pressure/battery/
 * vibration readings from a fleet of sensors). Not one of SPEC.md section
 * 8.2's five named domains - same "small standalone table, the lesson is
 * the mechanism" rationale as Lab 06's `counters` / Lab 31's `page_views` /
 * Lab 34's `activity_events`. Telemetry/metrics is explicitly one of the
 * SPEC.md Lab 35 example domains ("events / audit_logs / transactions"),
 * and it is the most natural real-world fit for RANGE partitioning: a
 * fleet of devices continuously reports readings, the table grows without
 * bound, almost every query either targets a recent time window (a
 * dashboard's "last 7 days" chart) or needs old data purged on a retention
 * schedule (compliance/cost) - exactly the two things this lab measures.
 *
 * ONLY this flat, non-partitioned table is declared here and managed by
 * Drizzle's migrator. The partitioned table (`metric_events_partitioned`
 * plus its monthly child partitions) is deliberately NOT declared as a
 * Drizzle schema object - see drizzle/0002_create_partitioned_table.sql and
 * README "Architecture" for why: `drizzle-kit`'s schema-diffing has no
 * concept of `PARTITION BY RANGE` / `PARTITION OF` / `ATTACH PARTITION` /
 * `DETACH PARTITION`, and letting it "see" a pgTable() with the same name
 * as a hand-partitioned table would fight the hand-authored DDL on every
 * subsequent `db:generate`. Per CLAUDE.md's "ORM plus SQL" principle, all
 * partitioned-table code in this lab talks to Postgres directly via `pg`
 * (raw SQL), which is the more honest tool for a lab whose entire point is
 * Postgres-specific DDL and planner behavior.
 */
export const metricEventsFlat = pgTable(
  "metric_events_flat",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: uuid("public_id").notNull().unique().defaultRandom(),
    deviceId: text("device_id").notNull(),
    metric: text("metric").notNull(),
    value: doublePrecision("value").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // Added in drizzle/0001_add_flat_index.sql, AFTER the naive (unindexed)
    // baseline scenario is captured - see README "Scenario"/"Observe". This
    // index is declared here too (rather than left off schema.ts entirely,
    // the way Lab 04 leaves its extra indexes off) because there is only
    // ONE index for this table and its presence/absence is the entire point
    // of Point 1 of this lab - keeping it visible in the typed schema makes
    // the intent explicit rather than implicit.
    index("metric_events_flat_recorded_at_idx").on(table.recordedAt),
  ],
);
