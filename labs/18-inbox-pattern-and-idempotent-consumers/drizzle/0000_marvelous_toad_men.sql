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
CREATE TABLE IF NOT EXISTS "processed_messages" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"account_id" bigint NOT NULL,
	"amount_cents" integer NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_messages_amount_cents_positive" CHECK ("processed_messages"."amount_cents" > 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "processed_messages" ADD CONSTRAINT "processed_messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
