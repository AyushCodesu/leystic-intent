CREATE TABLE IF NOT EXISTS "operator_bootstrap_state" (
  "id" text PRIMARY KEY NOT NULL,
  "is_bootstrapped" boolean DEFAULT false NOT NULL,
  "bootstrapped_at" timestamp with time zone,
  "bootstrapped_by" text,
  "recovery_count" integer DEFAULT 0 NOT NULL,
  "last_recovery_at" timestamp with time zone,
  "last_recovery_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

INSERT INTO "operator_bootstrap_state" ("id", "is_bootstrapped", "recovery_count")
VALUES ('singleton', false, 0)
ON CONFLICT ("id") DO NOTHING;
