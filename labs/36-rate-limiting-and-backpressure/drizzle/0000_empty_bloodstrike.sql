CREATE TABLE IF NOT EXISTS "jobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"worker_id" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "jobs_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "jobs_status_valid" CHECK ("jobs"."status" in ('pending', 'processing', 'completed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "queue_state" (
	"id" bigint PRIMARY KEY NOT NULL,
	"capacity" integer NOT NULL,
	"pending_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "queue_state_capacity_positive" CHECK ("queue_state"."capacity" > 0),
	CONSTRAINT "queue_state_pending_count_non_negative" CHECK ("queue_state"."pending_count" >= 0),
	CONSTRAINT "queue_state_pending_count_within_capacity" CHECK ("queue_state"."pending_count" <= "queue_state"."capacity")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_limit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rate_limit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"client_key" text NOT NULL,
	"algorithm" text NOT NULL,
	"allowed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_events_public_id_unique" UNIQUE("public_id")
);
