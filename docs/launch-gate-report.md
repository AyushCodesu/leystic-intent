# Insice Commercial Launch Gate & Source Readiness Report

**Document Status**: Official Release Audit  
**Date**: October 2026  
**Target Repository**: `AyushCodesu/leystic-intent`  
**Evaluation Scope**: Source Authorization, Data Retention, Deletion Workflows, and Shippable Capabilities  

---

## 1. Technically Enabled vs. Blocked Data Sources

The following table summarizes the technical configuration status across all external data sources integrated into the codebase:

| Source Identifier | Default Environment Flags | Runtime Gate Status | Technical Access Route | Notes |
|---|---|---|---|---|
| **Website Crawler** (`website_crawler`) | `N/A` (First-party) | **APPROVED** (Technically Enabled) | First-party HTTP client with IP pinning & SSRF rebinding prevention | Restricted to customer-configured domains and sitemaps only. |
| **LLM Inference** (`unclassified`) | `OPENROUTER_API_KEY` | **APPROVED** (Technically Enabled) | OpenRouter / Vercel AI Gateway | Used for prompt-based scoring, theme clustering, and summarization. |
| **Reddit** (`reddit`) | `REDDIT_SOURCE_ENABLED=false` | **BLOCKED** (Technically Disabled) | AnyAPI Gateway Proxy (`reddit.search`, `reddit.post`, etc.) | Fails closed. Cannot be queried or read by any background job, API, or worker. |
| **X / Twitter** (`x`) | `X_LEADS=false` | **PENDING** (Technically Disabled) | AnyAPI Gateway Proxy (`twitter.search`, `twitter.tweet`) | Fails closed. Feature dark; background scans and alert workers skip execution. |
| **Google Scraped SERP** (`google_scraped_serp`) | `GOOGLE_SERP_SOURCE_ENABLED=false` | **BLOCKED** (Technically Disabled) | AnyAPI Google Scraper | Fails closed. Disallowed under source policy. |
| **Google Official Search** (`google_official_api`) | Unconfigured | **BLOCKED** (Technically Disabled) | Google Custom Search JSON API | Unconfigured credentials; fails closed. |

All data acquisition paths strictly consult `assertSourceAuthorized()` / `isSourceAuthorized()`. When a source is `BLOCKED` or `PENDING`, queries, background jobs, cache lookups, and API reads fail closed with `SourceUnauthorizedError` or return empty result sets.

---

## 2. Verified External Commercial Authorization & Supporting Evidence

A technical implementation or automated test pass does **not** constitute legal or commercial clearance. The true external authorization status for each source is as follows:

| Source Identifier | Commercial Status | Verified External Evidence | Clear for Launch? |
|---|---|---|---|
| **First-Party Customer Website Crawler** | **Authorized** | Customer Terms of Service acceptance and authenticated project root URL configuration. First-party site crawling only. | **YES** |
| **LLM Inference Gateway** | **Authorized** | Commercial terms of service under provisioned OpenRouter and Vercel AI Gateway accounts. | **YES** |
| **Reddit (via AnyAPI)** | **UNAUTHORIZED** | **NO executed commercial contract exists with Reddit Inc.** Gateway scraping/proxying via AnyAPI does not grant a third-party commercial redistribution or lead-generation license under Reddit's Developer Terms. | **NO (P0 Launch Blocker)** |
| **X / Twitter (via AnyAPI)** | **UNAUTHORIZED** | **NO direct commercial developer agreement or enterprise contract executed.** Status remains in pilot review. | **NO (P0 Launch Blocker)** |
| **Google Scraped SERP** | **UNAUTHORIZED** | Scraped Google search results are prohibited by Google Terms of Service and cannot be commercially licensed via scraping gateways. | **NO (Permanently Blocked)** |
| **Google Official API (CSE)** | **Unconfigured** | Requires a dedicated Google Cloud billing project, approved Custom Search Engine (CSE ID), and provisioned API key. | **NO (Pending Configuration)** |

---

## 3. Provider-Derived Data Categories and Retention Matrix

All tables holding provider-derived content enforce bounded retention and decoupling policies:

| Data Category | Stored Database Tables | Stored Fields & Content | Retention Duration | Cleanup & Decoupling Behavior |
|---|---|---|---|---|
| **Reddit Posts** | `reddit_posts` | Thread metadata (id, url, subreddit, createdAt, score), title, raw body text (`body`), and API payload (`raw`). | **30 days** default (`RETENTION_DAYS`) | Unreferenced expired posts are deleted in bounded batches of 500 via `deleteExpiredPosts`. Referenced posts (by leads, SEO, or competitors) have raw `body` and `raw` JSON nulled out under `redactExpiredProviderContent`. |
| **Reddit Comments** | `reddit_comments` | Comment metadata, author, body text, permalink, raw API payload. | Follows parent post (max 30 days) | Deleted via `CASCADE` when unreferenced post is deleted. For referenced posts, comment `body` and `raw` are set to `null` past 30 days. |
| **Reddit Authors** | `reddit_authors` | Public username, avatar URL, karma, account creation date, raw JSON profile. | 30 days / Pruned when orphaned | `pruneOrphanedAuthors` deletes author profiles no longer referenced by any stored post or comment; raw API responses scrubbed after 30 days. |
| **X Posts** | `x_posts` | Tweet ID, author ID, tweet text, metrics, raw payload. | **30 days** (`RETENTION_DAYS`) | `deleteExpiredXData` deletes posts older than 30 days; cascades to `x_leads` and `x_evaluations`. |
| **X Authors** | `x_authors` | Username, name, bio description, followers, verified status, raw payload. | **30 days** (`RETENTION_DAYS`) | `deleteExpiredXData` deletes author records older than 30 days. |
| **Customer Leads** | `leads` | Business metrics (`score`, `fit`, `intent`, `engagement`), stage, reason, status, outcome tracking, matched phrase. | Indefinite (or until project deletion) | **Decoupled Retention**: Lead history preserves business insights and outcomes while raw provider content (`reddit_posts.body`, `leads.matchedPhrase`) is scrubbed past 30 days. Deleted via `deleteProject` cascade. |
| **Lead Evaluations** | `lead_evaluations` | Candidate verdict, need state, scoring metrics, verbatim evidence quote (`evidenceQuote`). | Follows post / project | Verbatim evidence quotes (`evidenceQuote`) are redacted past 30 days. Row cascades with `reddit_posts` or `projects`. |
| **Competitor Mentions** | `competitor_mentions` | Competitor name, sentiment, reason category, verbatim quote (`quote`), switching evidence (`switchingEvidence`). | 30-day display window; stored with project | Verbatim `quote` and `switchingEvidence` are scrubbed past 30 days under `redactExpiredProviderContent`. Rows cascade with `projects`. |
| **SEO Opportunities** | `seo_opportunities` | Tracked keyword, search position ranking, competitor presence flag, post link. | Indefinite (or until project deletion) | Post reference has `ON DELETE SET NULL`. Associated post raw content is scrubbed past 30 days. Deleted with `projects` cascade. |
| **Search Runs & SERP** | `search_runs`, `serp_results`, `search_run_posts` | Normalized query string, request ID, execution cost USD, funded-by entity. | Indefinite | Preserved for financial ledger accounting, daily house budget cap validation, and billing auditability. No raw post bodies stored. |
| **Website Pages** | `website_pages`, `website_inspections` | Customer page URL, title, headings, inspected content. | Preserved per inspection snapshot | Deleted with `projects` cascade. |

---

## 4. Deletion Detection Limitations and Workflows

### Technical Limitations
1. **No Upstream Push Deletion Events**: Third-party providers (Reddit and X via gateway) do not push webhooks or notifications when a user deletes a post, removes a comment, or deletes their account on the source platform.
2. **Detection on Refetch Only**: Upstream deletions can only be detected when a URL or thread is actively polled or re-fetched.
3. **Third-Party Right to Erasure**: Direct GDPR/CCPA requests executed on reddit.com or x.com cannot be automatically detected by Leystic.

### Implemented Deletion Workflows
To maintain rigorous compliance despite upstream platform constraints, the following internal deletion paths are operational:
- **Automatic Routine TTL Expiration (`deleteExpiredPosts`, `deleteExpiredXData`)**:
  - Automatically runs every 24 hours in bounded batches (`RETENTION_BATCH = 500`).
  - Unreferenced expired posts (> 30 days) are deleted completely.
  - Referenced posts have raw bodies and JSON payloads purged, decoupling lead business records from provider content.
  - Downstream excerpts (`leads.matchedPhrase`, `lead_evaluations.evidenceQuote`, `competitor_mentions.quote`, `post_readings.quote`) are wiped.
  - Orphaned authors in `reddit_authors` are pruned via `pruneOrphanedAuthors`.
- **Targeted Post Deletion (`deleteRedditPost`, `deleteXPost`)**:
  - Allows an operator or compliance officer to delete a specific post upon receiving an erasure request or DMCA notice.
  - Cascades cleanly across all comments, evaluations, readings, competitor mentions, and leads.
  - Prunes the author profile if orphaned.
  - Transactional and idempotent.
- **Targeted Author Erasure (`eraseRedditAuthor`, `eraseXAuthor`)**:
  - Anonymizes author attribution to `[deleted]` across all posts and comments.
  - Removes the author's profile row from `reddit_authors` / `x_authors`.
  - Transactional and idempotent.
- **Customer Project Deletion (`deleteProject`, `DELETE /api/v1/projects/:id`)**:
  - Authenticated and authorized project owner (or privileged operator) can delete an entire project.
  - Automatically cascades and deletes all project-specific records (`leads`, `lead_evaluations`, `seo_opportunities`, `competitor_mentions`, `pain_themes`, `alerts`, `jobs`, `website_inspections`).
  - **Multi-Tenant Isolation Guarantee**: Shared records (`reddit_posts`, `reddit_authors`, `search_runs`) referenced by other customers are preserved. If a shared post was only tracked by the deleted project, it becomes unreferenced and will be purged on the next retention run.
- **Privacy-Preserving Audit Trail**:
  - Administrative deletion actions record target type, target ID, operator ID, and timestamp in `operatorAuditLog`.
  - Deleted post bodies, comment text, and personal data are **never** copied into audit logs.

---

## 5. Shippable Capabilities Without Blocked Sources

Insice contains substantial commercial functionality that can safely ship today without enabling unauthorized third-party data sources:

1. **First-Party Customer Website Inspection & Demand Analysis**:
   - Crawling of authenticated customer domains and sitemaps.
   - Analysis of value propositions, customer segments, feature descriptions, and demand pages.
2. **Project and Team Workspaces**:
   - Multi-project management, workspace customization, keyword and competitor configuration.
3. **Alert and Notification Infrastructure**:
   - Slack webhook integrations, email alert channels, threshold configuration, invite workflows.
4. **Usage Ledger & Financial Cost Governance**:
   - Daily house budget caps, LLM spend limits, API request quota tracking, and billing auditability.
5. **Developer API & MCP Integration**:
   - Authenticated REST API (`/api/v1/projects`, `/api/v1/me`) with API key management, rate limits, and scopes.
   - MCP tool integration for programmatic interaction.
6. **Operator Authorization & Durable Credential Governance**:
   - PostgreSQL-backed operator credentials, cryptographic token validation, dual-control recovery, and cross-worker invalidation.

**Blocked Capabilities Until Authorized**:
- Live Reddit lead discovery and comment scanning.
- Live X buyer-intent tracking and reply discovery.
- Google SERP competitor search ranking discovery.

---

## 6. Outstanding External Actions Before Commercial Clearance

Software engineering and CI testing cannot substitute for legal contracts. The following external actions remain outstanding before live social sources can be enabled:

1. **Reddit Inc. Commercial Agreement**:
   - Execute an enterprise Data API commercial license with Reddit Inc. covering commercial SaaS lead generation and competitor tracking.
   - Agree on permitted retention durations, excerpt character limits (currently capped at 280 chars), and caching terms.
2. **X Corp. Commercial Developer Agreement**:
   - Execute a direct enterprise or commercial developer agreement with X Corp. (or migrate from AnyAPI to official X Enterprise v2 API endpoints).
3. **Official Google Custom Search Provisioning**:
   - Provision an official Google Cloud billing project.
   - Enable Custom Search JSON API.
   - Configure a Programmable Search Engine (CSE) and obtain `GOOGLE_CSE_ID` and `GOOGLE_CSE_API_KEY`.
   - Update `REC-GOOGLE-OFFICIAL-CSE` authorization record in the database from `BLOCKED` to `APPROVED` using authorized operator credentials.

Until the above external agreements are executed and verified, all third-party social sources must remain **BLOCKED** and **DISABLED** in production.
