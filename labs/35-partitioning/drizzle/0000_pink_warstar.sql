CREATE TABLE IF NOT EXISTS "metric_events_flat" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "metric_events_flat_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "metric_events_flat_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "metric_events_flat_recorded_at_idx" ON "metric_events_flat" USING btree ("recorded_at");