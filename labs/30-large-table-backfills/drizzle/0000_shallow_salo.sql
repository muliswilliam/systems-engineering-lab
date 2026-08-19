CREATE TABLE IF NOT EXISTS "orders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"customer_email" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"loyalty_points" integer,
	CONSTRAINT "orders_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_loyalty_points_pending" ON "orders" USING btree ("id") WHERE "orders"."loyalty_points" is null;