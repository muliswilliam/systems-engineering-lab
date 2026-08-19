CREATE TABLE IF NOT EXISTS "documents" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "documents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "documents_title_unique" UNIQUE("title"),
	CONSTRAINT "documents_version_positive" CHECK ("documents"."version" >= 1),
	CONSTRAINT "documents_status_valid" CHECK ("documents"."status" in ('draft', 'published'))
);
