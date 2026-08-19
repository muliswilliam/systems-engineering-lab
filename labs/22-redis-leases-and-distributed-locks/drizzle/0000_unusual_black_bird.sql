CREATE TABLE IF NOT EXISTS "resource_state" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "resource_state_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"fencing_token" bigint DEFAULT 0 NOT NULL,
	"last_writer" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_state_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "resource_state_name_unique" UNIQUE("name")
);
