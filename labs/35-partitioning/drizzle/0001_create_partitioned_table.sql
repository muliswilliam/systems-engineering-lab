-- Lab 35: the partitioned twin of metric_events_flat (0000_pink_warstar.sql),
-- created via `drizzle-kit generate --custom` because drizzle-kit's
-- schema-diffing (driven off src/db/schema.ts) has no vocabulary for
-- `PARTITION BY RANGE`, `PARTITION OF ... FOR VALUES FROM ... TO ...`,
-- `ATTACH PARTITION`, or `DETACH PARTITION` - if this table were also
-- declared as a pgTable() in schema.ts, drizzle-kit would try to manage it
-- as a plain table on every future `db:generate` and fight this hand-written
-- DDL. Per CLAUDE.md's "ORM plus SQL" principle, this table (and every
-- partition-maintenance operation against it, throughout this lab) is
-- addressed entirely with raw SQL via `pg` - see src/db/partitions.ts and
-- the src/scenarios/*.ts files.
--
-- SAME logical row shape as metric_events_flat, with two real, load-bearing
-- differences forced by Postgres's own partitioning rules (see README
-- "Fix it" / "Tradeoffs" for the full explanation):
--
-- 1. PRIMARY KEY (id, recorded_at), not PRIMARY KEY (id) alone. Postgres
--    requires every unique constraint (including a PRIMARY KEY) on a
--    partitioned table to include all of the partition key's columns, so
--    the partitioning column has to ride along in the key even though it
--    adds nothing to "uniqueness" that `id` alone didn't already give you.
-- 2. public_id has an index for lookups but NO UNIQUE constraint (unlike
--    metric_events_flat's real `UNIQUE(public_id)`). The same rule above
--    means a global "this UUID appears at most once across the whole
--    table" guarantee is not enforceable by Postgres here without also
--    stuffing `recorded_at` into that constraint - which would not even
--    give you the guarantee you actually want (it would only guarantee
--    uniqueness of the (public_id, recorded_at) PAIR). This is a genuine,
--    easy-to-miss limitation of RANGE partitioning, not an oversight.
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "metric_events_partitioned" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	PRIMARY KEY ("id", "recorded_at")
) PARTITION BY RANGE ("recorded_at");
--> statement-breakpoint

-- Declared on the PARENT, before any partitions exist yet. Postgres then
-- automatically creates a matching local index on every partition created
-- afterward via `... PARTITION OF ... FOR VALUES ...` (verified against a
-- real Postgres 16 instance while building this lab - see README
-- "Architecture"). This one statement is what makes every partition's
-- `recorded_at` genuinely indexed without 12 separate CREATE INDEX
-- statements below.
CREATE INDEX IF NOT EXISTS "metric_events_partitioned_recorded_at_idx" ON "metric_events_partitioned" USING btree ("recorded_at");
--> statement-breakpoint

-- Non-unique (see header comment above) - still useful for "look up one
-- reading by its public id" without a sequential scan.
CREATE INDEX IF NOT EXISTS "metric_events_partitioned_public_id_idx" ON "metric_events_partitioned" USING btree ("public_id");
--> statement-breakpoint

-- 12 monthly RANGE partitions covering all of calendar year 2025 - the
-- exact window this lab's seed data spans (see src/seed/seed.ts). Bounds
-- are half-open [FROM, TO) in UTC, so every possible `recorded_at` in 2025
-- has exactly one home. Deliberately NO partition for 2026 or earlier, and
-- NO DEFAULT partition - see src/scenarios/attach-and-missing-partition.ts
-- for the real captured error this produces on purpose, and why that error
-- is the entire operational point of this lab's Point 4.
CREATE TABLE IF NOT EXISTS "metric_events_y2025m01" PARTITION OF "metric_events_partitioned" FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metric_events_y2025m02" PARTITION OF "metric_events_partitioned" FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metric_events_y2025m03" PARTITION OF "metric_events_partitioned" FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metric_events_y2025m04" PARTITION OF "metric_events_partitioned" FOR VALUES FROM ('2025-04-01') TO ('2025-05-01');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metric_events_y2025m05" PARTITION OF "metric_events_partitioned" FOR VALUES FROM ('2025-05-01') TO ('2025-06-01');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metric_events_y2025m06" PARTITION OF "metric_events_partitioned" FOR VALUES FROM ('2025-06-01') TO ('2025-07-01');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metric_events_y2025m07" PARTITION OF "metric_events_partitioned" FOR VALUES FROM ('2025-07-01') TO ('2025-08-01');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metric_events_y2025m08" PARTITION OF "metric_events_partitioned" FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metric_events_y2025m09" PARTITION OF "metric_events_partitioned" FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metric_events_y2025m10" PARTITION OF "metric_events_partitioned" FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metric_events_y2025m11" PARTITION OF "metric_events_partitioned" FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metric_events_y2025m12" PARTITION OF "metric_events_partitioned" FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
