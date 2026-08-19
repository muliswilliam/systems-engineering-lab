CREATE TABLE IF NOT EXISTS "accounts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"owner_name" text NOT NULL,
	"balance_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "accounts_balance_cents_non_negative" CHECK ("accounts"."balance_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transfers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transfers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"from_account_id" bigint NOT NULL,
	"to_account_id" bigint NOT NULL,
	"amount_cents" integer NOT NULL,
	"mechanism" text NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "transfers_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "transfers_amount_cents_positive" CHECK ("transfers"."amount_cents" > 0),
	CONSTRAINT "transfers_accounts_distinct" CHECK ("transfers"."from_account_id" <> "transfers"."to_account_id"),
	CONSTRAINT "transfers_mechanism_valid" CHECK ("transfers"."mechanism" in ('naive', 'transactional')),
	CONSTRAINT "transfers_status_valid" CHECK ("transfers"."status" in ('pending', 'completed', 'failed'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_account_id_accounts_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_account_id_accounts_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
