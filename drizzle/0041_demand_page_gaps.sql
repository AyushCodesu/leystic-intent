CREATE TABLE IF NOT EXISTS "website_inspections" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "root_url" text NOT NULL,
  "status" text NOT NULL,
  "pages_found" integer DEFAULT 0 NOT NULL,
  "pages_crawled" integer DEFAULT 0 NOT NULL,
  "has_sitemap" boolean DEFAULT false NOT NULL,
  "error" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "website_inspections_project_idx" ON "website_inspections" ("project_id", "started_at" DESC);

CREATE TABLE IF NOT EXISTS "website_pages" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "inspection_id" text NOT NULL REFERENCES "website_inspections"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "canonical_url" text NOT NULL,
  "title" text,
  "description" text,
  "h1" text,
  "headings" text[],
  "path" text NOT NULL,
  "crawled_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "website_pages_project_idx" ON "website_pages" ("project_id");
CREATE INDEX IF NOT EXISTS "website_pages_inspection_idx" ON "website_pages" ("inspection_id");

CREATE TABLE IF NOT EXISTS "demand_page_confirmations" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "demand_group_id" text NOT NULL,
  "status" text NOT NULL,
  "confirmed_page_url" text,
  "notes" text,
  "confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "demand_page_confirmations_project_group_idx" ON "demand_page_confirmations" ("project_id", "demand_group_id");
