CREATE TABLE IF NOT EXISTS "payments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text,
	"amount_cents" integer NOT NULL,
	"payee" text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"confirmation_code" text,
	"processing_fee_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payments_amount_cents_positive" CHECK ("payments"."amount_cents" > 0),
	CONSTRAINT "payments_status_valid" CHECK ("payments"."status" in ('completed', 'failed'))
);
