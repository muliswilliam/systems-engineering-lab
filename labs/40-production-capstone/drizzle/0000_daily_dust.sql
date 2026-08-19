CREATE TABLE IF NOT EXISTS "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"venue_name" text NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_public_id" uuid NOT NULL,
	"correlation_id" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"outcome" text NOT NULL,
	"breaker_state" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"seat_id" bigint NOT NULL,
	"customer_id" text NOT NULL,
	"customer_email" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "orders_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "orders_status_valid" CHECK ("orders"."status" in ('created', 'failed')),
	CONSTRAINT "orders_amount_positive" CHECK ("orders"."amount_cents" > 0)
);
--> statement-breakpoint
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
	CONSTRAINT "outbox_events_attempts_non_negative" CHECK ("outbox_events"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seats" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "seats_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"event_id" bigint NOT NULL,
	"section" text NOT NULL,
	"seat_number" integer NOT NULL,
	"status" text DEFAULT 'AVAILABLE' NOT NULL,
	"reservation_token" uuid,
	"reserved_by" text,
	"reserved_until" timestamp with time zone,
	"sold_to" text,
	"price_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seats_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "seats_event_section_seat_number_key" UNIQUE("event_id","section","seat_number"),
	CONSTRAINT "seats_status_valid" CHECK ("seats"."status" in ('AVAILABLE', 'RESERVED', 'SOLD')),
	CONSTRAINT "seats_price_positive" CHECK ("seats"."price_cents" > 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_seat_id_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seats"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seats" ADD CONSTRAINT "seats_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_seat_id_idx" ON "orders" USING btree ("seat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_events_status_created_at_idx" ON "outbox_events" USING btree ("status","created_at");