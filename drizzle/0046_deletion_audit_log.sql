CREATE TABLE IF NOT EXISTS "deletion_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"actor_role" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"outcome" text NOT NULL,
	"reason_code" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deletion_audit_log_target_idx" ON "deletion_audit_log" USING btree ("target_type","target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deletion_audit_log_actor_idx" ON "deletion_audit_log" USING btree ("actor");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deletion_audit_log_created_at_idx" ON "deletion_audit_log" USING btree ("created_at");
