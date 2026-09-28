CREATE TABLE "provider_connections" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"secret_ciphertext" text,
	"secret_hint" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
