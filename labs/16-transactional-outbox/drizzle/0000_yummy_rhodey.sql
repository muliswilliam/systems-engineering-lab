CREATE TABLE IF NOT EXISTS "orders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"customer_name" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "orders_amount_cents_positive" CHECK ("orders"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbox_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" bigint NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "outbox_events_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "outbox_events_aggregate_type_valid" CHECK ("outbox_events"."aggregate_type" in ('order')),
	CONSTRAINT "outbox_events_event_type_valid" CHECK ("outbox_events"."event_type" in ('OrderCreated'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_aggregate_id_orders_id_fk" FOREIGN KEY ("aggregate_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
