CREATE TABLE IF NOT EXISTS "delivery_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "delivery_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"message_id" bigint NOT NULL,
	"attempt_number" integer NOT NULL,
	"outcome" text NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_log_outcome_valid" CHECK ("delivery_log"."outcome" in ('sent_lost', 'delivered_ack_lost', 'delivered_acked')),
	CONSTRAINT "delivery_log_attempt_number_positive" CHECK ("delivery_log"."attempt_number" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"recipient" text NOT NULL,
	"body" text NOT NULL,
	"scenario" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"receiver_processed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "notifications_scenario_valid" CHECK ("notifications"."scenario" in (
        'at_most_once_lost',
        'at_most_once_clean',
        'at_least_once_message_loss',
        'at_least_once_ack_loss',
        'effectively_once_ack_loss'
      )),
	CONSTRAINT "notifications_status_valid" CHECK ("notifications"."status" in ('pending', 'delivered', 'undelivered')),
	CONSTRAINT "notifications_receiver_processed_count_non_negative" CHECK ("notifications"."receiver_processed_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "processed_message_ids" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "processed_message_ids_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"message_id" bigint NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_message_ids_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_log" ADD CONSTRAINT "delivery_log_message_id_notifications_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."notifications"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "processed_message_ids" ADD CONSTRAINT "processed_message_ids_message_id_notifications_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."notifications"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
