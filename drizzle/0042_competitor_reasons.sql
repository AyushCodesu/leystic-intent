ALTER TABLE "competitor_mentions" ADD COLUMN IF NOT EXISTS "reason_category" text;
ALTER TABLE "competitor_mentions" ADD COLUMN IF NOT EXISTS "switching_evidence" text;
ALTER TABLE "competitor_mentions" ADD COLUMN IF NOT EXISTS "explanation" text;
