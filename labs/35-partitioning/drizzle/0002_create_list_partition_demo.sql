-- Lab 35, Point 5 (LIST partitioning contrast): a small, separate table
-- partitioned by a discrete category column (region) instead of a date
-- range. Not part of the main RANGE-partitioning performance story above -
-- this exists purely so the README/scenario can show the mechanism is the
-- same idea applied to a different kind of key: RANGE splits a continuous
-- domain (time) into contiguous bands, LIST splits a discrete domain
-- (a fixed or slowly-growing set of category values) into named buckets.
--
-- Same PRIMARY KEY rule as the RANGE table applies here too: the partition
-- key (region) must be part of the key.
--
-- Deliberately created WITHOUT a DEFAULT partition (see
-- src/scenarios/list-partitioning.ts, which reproduces the exact same
-- class of "no partition of relation ... found for row" error LIST
-- partitioning shares with RANGE, then fixes it by ATTACHing a DEFAULT
-- partition here - the one place in this lab that demonstrates the DEFAULT
-- partition escape hatch end to end).
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "metric_events_by_region" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"region" text NOT NULL,
	"device_id" text NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	PRIMARY KEY ("id", "region")
) PARTITION BY LIST ("region");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "metric_events_by_region_recorded_at_idx" ON "metric_events_by_region" USING btree ("recorded_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "metric_events_by_region_us" PARTITION OF "metric_events_by_region" FOR VALUES IN ('us');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metric_events_by_region_eu" PARTITION OF "metric_events_by_region" FOR VALUES IN ('eu');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "metric_events_by_region_apac" PARTITION OF "metric_events_by_region" FOR VALUES IN ('apac');
