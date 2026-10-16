ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "outcome" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "outcome_recorded_at" timestamp with time zone;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "outcome_notes" text;
