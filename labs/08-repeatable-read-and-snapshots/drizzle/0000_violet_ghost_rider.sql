CREATE TABLE IF NOT EXISTS "accounts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"balance_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "accounts_name_unique" UNIQUE("name"),
	CONSTRAINT "accounts_balance_cents_non_negative" CHECK ("accounts"."balance_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "on_call_staff" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "on_call_staff_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_on_call" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "on_call_staff_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "on_call_staff_name_unique" UNIQUE("name")
);
