CREATE TABLE IF NOT EXISTS "activity_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "activity_events_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_events_created_at_id_idx" ON "activity_events" USING btree ("created_at","id");