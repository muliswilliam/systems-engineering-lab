CREATE TABLE IF NOT EXISTS "outbox_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "outbox_events_status_valid" CHECK ("outbox_events"."status" in ('pending', 'processing', 'published', 'failed')),
	CONSTRAINT "outbox_events_attempts_non_negative" CHECK ("outbox_events"."attempts" >= 0),
	CONSTRAINT "outbox_events_max_attempts_positive" CHECK ("outbox_events"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "processed_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "processed_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_public_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_event_public_id_unique" UNIQUE("event_public_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_events_status_created_at_idx" ON "outbox_events" USING btree ("status","created_at");