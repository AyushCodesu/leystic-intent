CREATE TABLE IF NOT EXISTS "source_auth_records" (
  "record_id" text PRIMARY KEY NOT NULL,
  "source_id" text NOT NULL,
  "name" text NOT NULL,
  "status" text NOT NULL,
  "authorized_purposes" jsonb NOT NULL,
  "scopes" jsonb NOT NULL,
  "effective_date" timestamp with time zone NOT NULL,
  "expiration_date" timestamp with time zone,
  "evidence_reference" text NOT NULL,
  "approval_provenance" jsonb NOT NULL,
  "revocation_reason" text,
  "revoked_at" timestamp with time zone,
  "revoked_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "source_auth_records_source_id_idx" ON "source_auth_records" ("source_id");
CREATE INDEX IF NOT EXISTS "source_auth_records_status_idx" ON "source_auth_records" ("status");

CREATE TABLE IF NOT EXISTS "source_auth_audit_events" (
  "id" text PRIMARY KEY NOT NULL,
  "record_id" text NOT NULL REFERENCES "source_auth_records"("record_id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "performed_by" text NOT NULL,
  "actor_role" text NOT NULL,
  "evidence_reference" text NOT NULL,
  "reason" text NOT NULL,
  "previous_status" text,
  "new_status" text NOT NULL,
  "details" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "source_auth_audit_events_record_id_idx" ON "source_auth_audit_events" ("record_id");
CREATE INDEX IF NOT EXISTS "source_auth_audit_events_created_at_idx" ON "source_auth_audit_events" ("created_at");

-- Seed default authoritative records (DO NOT promote blocked or pending sources)
INSERT INTO "source_auth_records" (
  "record_id", "source_id", "name", "status", "authorized_purposes", "scopes",
  "effective_date", "expiration_date", "evidence_reference", "approval_provenance"
) VALUES
(
  'REC-REDDIT-COMMERCIAL-UNVERIFIED',
  'reddit',
  'Reddit (via AnyAPI Gateway)',
  'BLOCKED',
  '["commercial_lead_generation", "competitor_intelligence", "seo_opportunity_discovery"]'::jsonb,
  '["commercial_indexing", "search_discovery", "social_content_read", "comments_read"]'::jsonb,
  '2026-10-01T00:00:00.000Z'::timestamptz,
  NULL,
  'https://www.redditinc.com/policies/data-api-terms (Direct commercial contract not executed)',
  '{"approvedBy": "Legal and Compliance Review", "reviewedAt": "2026-10-19T00:00:00.000Z", "notes": "BLOCKED launch blocker: AnyAPI gateway proxy does not convey commercial rights from Reddit Inc. Direct developer licensing required."}'::jsonb
),
(
  'REC-X-PILOT-REVIEW',
  'x',
  'X / Twitter (via AnyAPI Gateway)',
  'PENDING',
  '["social_intent_monitoring"]'::jsonb,
  '["social_intent_monitoring", "search_discovery", "social_content_read", "profile_metadata_read"]'::jsonb,
  '2026-10-01T00:00:00.000Z'::timestamptz,
  NULL,
  'https://developer.x.com/en/more/developer-terms/agreement-and-policy',
  '{"approvedBy": "Compliance Team", "reviewedAt": "2026-10-19T00:00:00.000Z", "notes": "PENDING pilot review: Commercial license execution pending. Source feature flag X_LEADS must remain off."}'::jsonb
),
(
  'REC-GOOGLE-ANYAPI-SCRAPED',
  'google_scraped_serp',
  'Google Search (via AnyAPI Scraped SERP)',
  'BLOCKED',
  '["seo_opportunity_discovery"]'::jsonb,
  '["search_discovery"]'::jsonb,
  '2026-10-01T00:00:00.000Z'::timestamptz,
  NULL,
  'https://policies.google.com/terms',
  '{"approvedBy": "Legal Review", "reviewedAt": "2026-10-19T00:00:00.000Z", "notes": "BLOCKED: Third-party scraping gateway does not hold direct search syndication license from Google LLC."}'::jsonb
),
(
  'REC-GOOGLE-OFFICIAL-CSE',
  'google_official_api',
  'Google Custom Search JSON API (Official)',
  'BLOCKED',
  '["seo_opportunity_discovery"]'::jsonb,
  '["search_discovery"]'::jsonb,
  '2026-10-01T00:00:00.000Z'::timestamptz,
  NULL,
  'https://cloud.google.com/terms/service-terms',
  '{"approvedBy": "Compliance Review", "reviewedAt": "2026-10-19T00:00:00.000Z", "notes": "BLOCKED (Unconfigured): Direct Google Cloud project credentials, API key, and Custom Search Engine ID not yet configured."}'::jsonb
),
(
  'REC-WEBSITE-CRAWLER-FIRST-PARTY',
  'website_crawler',
  'Target Website First-Party Crawler',
  'APPROVED',
  '["customer_website_coverage"]'::jsonb,
  '["customer_domain_crawl"]'::jsonb,
  '2026-10-01T00:00:00.000Z'::timestamptz,
  NULL,
  'Leystic Customer Terms of Service (Section 4: Configured Domain Authorization)',
  '{"approvedBy": "Platform Architecture Review", "reviewedAt": "2026-10-19T00:00:00.000Z", "notes": "APPROVED: Limited strictly to customer-configured root domains. Disallows arbitrary open-web traversal and includes strict SSRF safeguards."}'::jsonb
),
(
  'REC-LLM-INFERENCE-GATEWAY',
  'unclassified',
  'LLM Gateway Inference (OpenRouter / Vercel AI Gateway)',
  'APPROVED',
  '["commercial_lead_generation", "competitor_intelligence", "seo_opportunity_discovery"]'::jsonb,
  '["commercial_indexing"]'::jsonb,
  '2026-10-01T00:00:00.000Z'::timestamptz,
  NULL,
  'OpenRouter Terms of Service & Vercel AI Gateway Data Processing Agreements',
  '{"approvedBy": "Information Security & Compliance", "reviewedAt": "2026-10-19T00:00:00.000Z", "notes": "APPROVED: Multi-provider DPAs in place prohibiting model training on customer prompt payloads."}'::jsonb
)
ON CONFLICT ("record_id") DO NOTHING;

-- Seed initial registration audit events for default records
INSERT INTO "source_auth_audit_events" (
  "id", "record_id", "action", "performed_by", "actor_role", "evidence_reference", "reason", "previous_status", "new_status", "created_at"
) VALUES
('audit_seed_reddit', 'REC-REDDIT-COMMERCIAL-UNVERIFIED', 'REGISTER', 'Legal and Compliance Review', 'compliance_officer', 'https://www.redditinc.com/policies/data-api-terms', 'Initial register seeding: BLOCKED pending commercial contract', NULL, 'BLOCKED', now()),
('audit_seed_x', 'REC-X-PILOT-REVIEW', 'REGISTER', 'Compliance Team', 'compliance_officer', 'https://developer.x.com/en/more/developer-terms/agreement-and-policy', 'Initial register seeding: PENDING pilot evaluation', NULL, 'PENDING', now()),
('audit_seed_google_scraped', 'REC-GOOGLE-ANYAPI-SCRAPED', 'REGISTER', 'Legal Review', 'compliance_officer', 'https://policies.google.com/terms', 'Initial register seeding: BLOCKED scraped SERP', NULL, 'BLOCKED', now()),
('audit_seed_google_official', 'REC-GOOGLE-OFFICIAL-CSE', 'REGISTER', 'Compliance Review', 'compliance_officer', 'https://cloud.google.com/terms/service-terms', 'Initial register seeding: BLOCKED unconfigured CSE', NULL, 'BLOCKED', now()),
('audit_seed_crawler', 'REC-WEBSITE-CRAWLER-FIRST-PARTY', 'REGISTER', 'Platform Architecture Review', 'system_administrator', 'Leystic Customer Terms of Service (Section 4)', 'Initial register seeding: APPROVED first-party crawler', NULL, 'APPROVED', now()),
('audit_seed_llm', 'REC-LLM-INFERENCE-GATEWAY', 'REGISTER', 'Information Security & Compliance', 'compliance_officer', 'OpenRouter & Vercel DPA', 'Initial register seeding: APPROVED inference gateway', NULL, 'APPROVED', now())
ON CONFLICT ("id") DO NOTHING;
