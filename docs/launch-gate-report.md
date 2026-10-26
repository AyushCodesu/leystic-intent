# Insice Commercial Launch Gate & Source Readiness Report

- **Document Status**: Official Release Audit
- **Date**: October 2026
- **Target Repository**: `AyushCodesu/leystic-intent`
- **Branch**: `fix/durable-operator-credentials-and-validation`
- **Evaluation Scope**: Provider Text Inventory, Source Authorization Gates, Retention Decoupling, Deletion Workflows, Multi-Tenant Safety, and Audit Logging

---

## 1. Provider-Derived Text and Personal Data Inventory

An exhaustive audit of all database schemas (`src/db/schema/shared.ts`, `src/db/schema/tenant.ts`, `src/db/schema/competitors.ts`, `src/db/schema/x.ts`) was performed to catalog all provider-derived text, quotes, and personal/profile fields.

| Field Identifier | Origin & Upstream Provider | Contains Copied Text? | Contains Personal Info? | Intended Retention Period | Cleanup & Redaction Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `reddit_posts.title` | Reddit Data API post title | **Yes** (Author post title) | Potentially in title | **30 days** (`RETENTION_DAYS`) | **Redacted**: Replaced with neutral placeholder `[Redacted / Expired]` (`REDACTED_TITLE`) when post is expired and referenced; dropped on post deletion. |
| `reddit_posts.body` | Reddit post body / markdown | **Yes** (Full post text) | Potentially in body | **30 days** (`RETENTION_DAYS`) | **Redacted**: Set to `null` past 30 days under `redactExpiredProviderContent`; dropped on post deletion. |
| `reddit_posts.url` | Reddit API thread canonical URL | No (Canonical URL structure) | No | **30 days** (`RETENTION_DAYS`) | **Retained on referenced rows; pruned on unreferenced deletion**: Preserved on referenced posts past 30 days so founders can verify the thread directly on reddit.com. Dropped on post cascade. |
| `reddit_posts.raw` | Raw Reddit API post JSON | **Yes** (Full payload) | **Yes** (Metadata, author) | **30 days** (`RETENTION_DAYS`) | **Redacted**: Set to `null` past 30 days; dropped on post deletion. |
| `reddit_posts.author` | Reddit author username | No | **Yes** (Online identity) | **30 days** (`RETENTION_DAYS`) | **Anonymized**: Replaced with `[deleted]` (`REDACTED_AUTHOR`) when post expires; row pruned when unreferenced. |
| `reddit_posts.imageUrl` | Reddit preview media URL | No | No | **30 days** (`RETENTION_DAYS`) | **Redacted**: Set to `null` past 30 days. |
| `reddit_comments.body` | Reddit comment body text | **Yes** (Full comment) | Potentially in comment | Follows parent (max 30d) | **Redacted**: Set to `null` past 30 days; dropped via CASCADE on unreferenced post deletion. |
| `reddit_comments.permalink` | Reddit comment anchor permalink | No (Comment anchor URL) | No | Follows parent (max 30d) | **Retained on referenced rows; pruned on unreferenced deletion**: Preserved on referenced comment records so lead cards link directly to comment anchor; dropped on parent post deletion. |
| `reddit_comments.raw` | Raw Reddit API comment JSON | **Yes** (Full payload) | **Yes** (Metadata, author) | Follows parent (max 30d) | **Redacted**: Set to `null` past 30 days. |
| `reddit_comments.author` | Reddit comment author username | No | **Yes** (Online identity) | Follows parent (max 30d) | **Anonymized**: Replaced with `[deleted]` (`REDACTED_AUTHOR`) past 30 days. |
| `subreddits.rulesText` | Subreddit sidebar moderation rules | **Yes** (Public community guidelines) | No (Community rules, not user PII) | **7 days** (Reuse & refresh cadence) | **Refreshed**: Overwritten on subsequent sweeps. Independent of user posts; dropped when project or database resets. |
| `subreddits.promoPolicy` | LLM-extracted self-promotion policy | Derived policy summary | No | **7 days** (Reuse & refresh cadence) | **Refreshed**: Overwritten on re-fetch. Guides safe engagement without storing personal data. |
| `reddit_authors.avatarUrl` | Reddit profile avatar image | No | **Yes** (User image) | **30 days from fetch** | **Scrubbed**: Set to `null` past 30 days from `fetchedAt` even if author is referenced; row deleted when unreferenced. |
| `reddit_authors.karma` | Reddit karma score | No | No | **30 days from fetch** | **Scrubbed**: Set to `null` past 30 days from `fetchedAt`; row deleted when unreferenced. |
| `reddit_authors.accountCreatedAt`| Reddit account opening date | No | No | **30 days from fetch** | **Scrubbed**: Set to `null` past 30 days from `fetchedAt`; row deleted when unreferenced. |
| `reddit_authors.raw` | Raw Reddit author API payload | **Yes** (Bio & metadata) | **Yes** (Full profile) | **30 days from fetch** | **Scrubbed**: Set to `null` past 30 days from `fetchedAt`; row deleted when unreferenced. |
| `leads.matchedPhrase` | Verbatim quote from post/comment | **Yes** (Exact snippet) | Potentially | **30 days** | **Redacted**: Set to `null` past 30 days; preserved business lead row (score, stage, status). |
| `leads.reason` | Synthetic lead classification sentence | **No** (Template sentence built from enums) | **No** | Indefinite | Preserved for customer lead history. Does not copy verbatim provider text. |
| `leads.notFitReason` | Customer user-entered disqualification tag | **No** (Customer categorization) | **No** | Indefinite | Preserved for customer review. |
| `leads.outcomeNotes` | Customer user-authored business notes | **No** (Customer note) | **No** | Indefinite | Preserved for customer pipeline history. |
| `lead_evaluations.evidenceQuote` | Extracted need quote | **Yes** (Verbatim excerpt) | Potentially | **30 days** | **Redacted**: Set to `null` past 30 days under `redactExpiredProviderContent`. |
| `lead_evaluations.reason` | Classifier synthetic explanation | **No** (Synthetic template) | **No** | Follows evaluation | Preserved for candidate verdict consistency. |
| `competitor_mentions.quote` | Verbatim sentence naming competitor | **Yes** (Exact quote) | Potentially | **30 days** | **Redacted**: Set to `null` past 30 days. |
| `competitor_mentions.switchingEvidence`| Verbatim switching evidence phrase | **Yes** (Exact quote) | Potentially | **30 days** | **Redacted**: Set to `null` past 30 days. |
| `competitor_mentions.summary` | LLM-generated mention summary | Derived summary | No | **30 days** | **Redacted**: Set to `null` past 30 days to prevent retaining derived narrative fragments. |
| `competitor_mentions.explanation` | LLM-generated switching rationale | Derived explanation | No | **30 days** | **Redacted**: Set to `null` past 30 days. Business indicators (competitor, sentiment) kept. |
| `post_readings.quote` | Verbatim statement of buyer need | **Yes** (Exact sentence) | Potentially | **30 days** | **Redacted**: Set to `null` past 30 days; categorical `relationship` and `needState` preserved. |
| `serp_results.title` / `.snippet` | Google SERP result title & snippet | **Yes** (Search result text) | No | Bound to search run | Dropped on search run cleanup or cascade. |
| `discovery_evidence.snippet` | Discovered Google thread snippet | **Yes** (Search snippet) | No | Project discovery | Cascades with `projects` deletion. |
| `x_posts.id` | X snowflake post ID string | No (Numeric snowflake ID) | No | **30 days** (`RETENTION_DAYS`) | **Purged**: Completely deleted past 30 days via `deleteExpiredXData`. Cascades to all dependent records. |
| `x_posts.text` | Tweet body text | **Yes** (Full tweet) | Potentially | **30 days** (`RETENTION_DAYS`) | **Purged**: Completely deleted past 30 days (`deleteExpiredXData`); cascades to leads/evals. |
| `x_posts.authorUsername` / `authorName` | X handle and display name | No | **Yes** (Identity) | **30 days** (`RETENTION_DAYS`) | Deleted with tweet past 30 days. |
| `x_authors.username` | X author Twitter handle | No | **Yes** (Public handle / online identity) | **30 days** (`RETENTION_DAYS`) | **Purged / Anonymized**: Deleted past 30 days via `deleteExpiredXData` or immediately on `eraseXAuthor`. Anonymized to opaque target reference in audit logs. |
| `x_authors.bio` / `name` / `website` | X author profile details | **Yes** (Bio description) | **Yes** (Personal info) | **30 days** (`RETENTION_DAYS`) | Deleted past 30 days via `deleteExpiredXData`. |
| `x_evaluations.matchedPhrase` / `needQuote` | Verbatim tweet quotes | **Yes** (Exact quotes) | Potentially | **30 days** | Cascades with `x_posts` deletion. |
| `x_leads.matchedPhrase` | Verbatim tweet quote | **Yes** (Exact quote) | Potentially | **30 days** | Cascades with `x_posts` deletion. |

### Source Identifiers, URLs, and Community Policy Retention Rationale

#### 1. Retention of Canonical Discussion URLs (`reddit_posts.url`, `reddit_comments.permalink`)
When a Reddit post or comment exceeds the 30-day retention clock but remains referenced by an active customer lead, SEO opportunity, or competitor mention, Leystic redacts all provider-derived body text, titles, raw JSON payloads, and author handles (`title` -> `[Redacted / Expired]`, `body` -> `null`, `raw` -> `null`, `author` -> `[deleted]`).
However, the structural URL links (`reddit_posts.url`, `reddit_comments.permalink`) are intentionally retained on the preserved metadata row.
- **Appropriateness Justification**:
  1. *No Personal Data or Private Text*: The URL string is a structural web address (`https://www.reddit.com/r/.../comments/...`) containing only the subreddit name and alphanumeric identifier slugs. It contains no personal information, author username, or body text.
  2. *Origin Verification Without Ghost Data*: Because Leystic's database redaction strips the stored copy of the post text, the customer needs a mechanism to verify the source directly. Retaining the canonical link allows founders to click through to view the live conversation on Reddit in their browser.
  3. *Upstream Deletion Compliance*: If the author or moderators delete the post or comment upstream on Reddit, clicking the canonical link immediately serves Reddit's native 404 or `[deleted]` page. Because Leystic stores no residual text, the deletion is natively and completely respected at the source without lingering ghost copies in Leystic's database.
  4. *Lifecycle Coupling*: When all referencing projects delete their leads or the customer deletes their project, the post/comment rows become unreferenced and are permanently deleted from database storage by routine retention sweeps (`deleteExpiredPosts`).

#### 2. Retention of Subreddit Rules and Promotion Policies (`subreddits.rulesText`, `subreddits.promoPolicy`)
- Community rules and promotion summaries reflect publicly published subreddit guidelines (e.g. self-promotion restrictions, weekly showcase threads).
- They contain no private communications, individual personal information, or user-generated post text.
- They are cached for a short 7-day reuse cycle (`FETCH_REUSE_DAYS.subreddit = 7`) and overwritten on subsequent sweeps, ensuring guidance remains current.

#### 3. X Source Identifiers (`x_posts.id`, `x_authors.username`)
- `x_posts.id` is the immutable snowflake identifier from X/Twitter used for relational integrity during the 30-day active window. Unlike Reddit, X leads do not prevent tweet deletion; after 30 days, tweets are purged completely via `deleteExpiredXData`.
- `x_authors.username` is the lowercase Twitter handle. Retained only during the active 30-day window; deleted permanently upon TTL expiry or operator erasure (`eraseXAuthor`). In audit records, author usernames are never persisted and are strictly anonymized to opaque `anon-author-<uuid>` references.

---

## 2. Technically Enabled vs. Blocked Data Sources

All runtime source gates consult `assertSourceAuthorized()` / `isSourceAuthorized()` in `src/lib/sourcePolicy.ts`:

| Source Identifier | Technical Status | Gate Record | Runtime Default | Commercial Clearance Status | Launch Posture |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **First-Party Crawler** (`website_crawler`) | **ENABLED** | `REC-WEBSITE-CRAWLER-FIRST-PARTY` | Active | Customer Terms & Verified Root URLs | **Launch Ready** (Scope strictly limited to authenticated customer domains) |
| **LLM Inference** (`unclassified`) | **ENABLED** | N/A (Standard SaaS APIs) | Active | OpenRouter / Vercel AI Gateway Commercial Terms | **Launch Ready** |
| **Reddit Data API** (`reddit`) | **BLOCKED** | `REC-REDDIT-COMMERCIAL-UNVERIFIED` | `REDDIT_SOURCE_ENABLED=false` | **UNAUTHORIZED** (No commercial developer agreement with Reddit Inc.) | **P0 Launch Blocker** (Remains blocked fail-closed) |
| **X / Twitter API** (`x`) | **PENDING** | `REC-X-PILOT-REVIEW` | `X_LEADS=false` | **UNAUTHORIZED** (No executed enterprise/commercial developer contract) | **P0 Launch Blocker** (Feature remains dark fail-closed) |
| **Google Scraped SERP** (`google_scraped_serp`) | **BLOCKED** | `REC-GOOGLE-ANYAPI-SCRAPED` | `GOOGLE_SERP_SOURCE_ENABLED=false` | **UNAUTHORIZED** (Prohibited under Google Terms of Service) | **Permanently Barred** |
| **Google Official API** (`google_official_api`) | **BLOCKED** | `REC-GOOGLE-OFFICIAL-CSE` | Unconfigured credentials | **Pending Configuration** (Google Cloud billing and CSE ID needed) | **Blocked Until Configured** |

All acquisition routes fail closed. Background workers, manual sync jobs, cached reads, and API endpoints cannot bypass the technical gate.

---

## 3. Data Retention Clock Definition and Scenario Enforcement

### The Retention Clock
- **Reddit Posts & Comments**: The retention clock for Reddit content is measured from **source publication timestamp (`createdAt`)**. Leystic operates as a fresh buyer-intent monitor with a 30-day feed window (`TIERS.free.feedWindowDays = 30`). Rows published more than 30 days prior to the evaluation time (`createdAt < cutoff`) are eligible for routine TTL processing.
- **Reddit Author Profiles (4-Tier Lifecycle)**:
  1. *Expiry of Raw Payloads*: Raw API profile payloads (`reddit_authors.raw`) older than 30 days from acquisition (`fetchedAt < cutoff`) are scrubbed (`raw = null`).
  2. *Expiry of Profile Attributes*: Personal profile fields (`avatarUrl`, `karma`, `accountCreatedAt`) are scrubbed to `null` past 30 days from `fetchedAt` even if the author is still referenced by an active post or comment. Only the primary key identifier (`username`) is preserved to keep relational joins valid.
  3. *Anonymization of Identifiers*: Upon operator author erasure request (`eraseRedditAuthor`) or Right-to-be-Forgotten actions, referencing posts and comments are anonymized to `[deleted]`, and the author profile row is deleted.
  4. *Deletion of Orphaned Rows*: Rows in `reddit_authors` with no referencing posts or comments are permanently deleted from database storage via `pruneOrphanedAuthors`.
- **Comment-Level Competitor Mention Retention**:
  - Retention strictly respects each record's own publication age. Post-level mentions (`commentId IS NULL`) track `post.createdAt < cutoff`. Comment-level mentions (`commentId IS NOT NULL`) track `comment.createdAt < cutoff`.
  - When an old post (>30 days) holds a recent comment (<30 days), the comment's competitor evidence (`quote`, `summary`, `switchingEvidence`, `explanation`) is **strictly preserved** until the comment's own 30-day cutoff, preventing premature data loss. Once the comment itself passes 30 days, its quotes and derived narrative fields are scrubbed.
- **X Content**: Measured from **both publication (`createdAt`) and acquisition (`fetchedAt`)**. Content must be older than 30 days across both clocks before being purged.

### Retention Scenarios Verified in Automated Tests
1. **Old Content Fetched Recently**:
   - If an older thread (published >30 days ago) is ingested during backfill or search discovery, it enters the system with its true source `createdAt`.
   - On the next routine retention run, if unreferenced, it is pruned. If referenced by an active lead, SEO row, or competitor mention, its raw provider text (`title`, `body`, `raw`, `author`, `imageUrl`) is immediately redacted to neutral placeholders while customer business lead history is preserved.
2. **Old Posts with Newer Comments**:
   - If a post was published >30 days ago (`post.createdAt < cutoff`) but contains newer unexpired comments (`comment.createdAt >= cutoff`), the parent post container is **not deleted**.
   - Deleting the post row would trigger a PostgreSQL `ON DELETE CASCADE` destroying the fresh comments.
   - The retention engine redacts the old post body and title to neutral placeholders while preserving the post row and keeping the newer comments completely unredacted and intact.
3. **Content That Has Already Been Redacted**:
   - `redactExpiredProviderContent` strictly filters for unredacted content:
     `body is not null or raw is not null or imageUrl is not null or title <> '[Redacted / Expired]' or (author is not null and author <> '[deleted]')`.
   - Once redacted, rows do not match the filter.
   - Repeated cleanup passes and dry-run calculations (`{ dryRun: true }`) accurately return `0` without re-processing or thrashing row locks.
4. **Posts Referenced by Multiple Tenants**:
   - Shared multi-tenant records (`reddit_posts`) referenced by Tenant A and Tenant B preserve their shared metadata row even after 30 days, while raw provider text is scrubbed.
   - If Tenant A deletes their project, Tenant B's lead and access to the shared post record remain completely intact.
   - Only when *all* referencing tenants have deleted their projects does the post become unreferenced and eligible for deletion on the subsequent routine retention pass.
5. **Repeated Runs and Partial Failures**:
   - Operations are bounded by `RETENTION_BATCH = 500` and executed idempotently.
   - A crash or partial failure commits processed batches safely without corrupting foreign keys or leaving orphaned state. Subsequent runs seamlessly resume from where the previous batch finished.

---

## 4. Deletion Workflows, Authorization, and Audit Logging

### Privileged Operator Deletion Authorization
Operator-only destructive operations:
- `deleteRedditPost(postId, options)`
- `eraseRedditAuthor(username, options)`
- `deleteXPost(tweetId, options)`
- `eraseXAuthor(username, options)`

**Trust Boundary Enforcement**:
- `options.operatorContext` is **strictly required**.
- Omitting `operatorContext` or passing an unauthenticated context throws `OperatorApprovalRequiredError` or `OperatorAuthorizationError`.
- Caller identity and permissions are verified against durable cryptographic operator credentials in PostgreSQL via `assertAuthorizedOperator()`.
- Unprivileged application modules and unauthenticated callers are rejected fail-closed.

### Project Deletion & Multi-Tenant Decoupling
- `deleteProject(userId, projectId, options)` enforces authenticated ownership:
  - If called by an ordinary customer, verifies `projects.userId === userId`.
  - If called by an operator, verifies `options.operatorContext` has appropriate administrator roles.
  - Cascades all project-specific tables (`leads`, `lead_evaluations`, `seo_opportunities`, `competitor_mentions`, `pain_themes`, `alerts`, `jobs`, `website_inspections`, `x_projects`, `x_lanes`, `x_evaluations`, `x_leads`).
  - Leaves shared multi-tenant records (`reddit_posts`, `reddit_authors`, `search_runs`) intact to prevent data loss for other customers.
  - Publicly exposed to authenticated customers via `DELETE /api/v1/projects/:id`.

### Append-Only Deletion Audit Ledger (`deletion_audit_log`)
All deletion workflows durably record audit events in `deletion_audit_log` (`operatorAuditLog` alias):
- **Schema**:
  - `id`: Unique UUID primary key.
  - `action`: Operation name (`DELETE_PROJECT`, `DELETE_REDDIT_POST`, `ERASE_REDDIT_AUTHOR`, `DELETE_X_POST`, `ERASE_X_AUTHOR`, `TTL_BATCH_CLEANUP`).
  - `actor`: Operator ID, Customer User ID, or System Service identifier (`system:routine_ttl`).
  - `actorRole`: `system_administrator`, `compliance_officer`, `project_owner`, or `system_service`.
  - `targetType`: Target category (`project`, `reddit_post`, `reddit_author`, `x_post`, `x_author`, `retention_batch`, `x_retention_batch`).
  - `targetId`: Opaque target identifier or batch timestamp.
  - `outcome`: `SUCCESS`, `NOT_FOUND`, `DENIED`, or `FAILURE`.
  - `reasonCode`: Business/compliance reason (`OPERATOR_DELETION`, `AUTHOR_ERASURE_REQUEST`, `USER_REQUEST`, `ROUTINE_TTL_EXPIRY`, `ROUTINE_TTL_FAILURE`).
  - `details`: Structured non-identifying metadata (e.g. counts of records deleted, anonymized, or pruned).
  - `created_at`: Authoritative UTC timestamp.

- **Database-Level Immutability Enforcement**:
  - Strictly append-only at the PostgreSQL database level via migration `0047_immutable_deletion_audit.sql`.
  - Row-level trigger `trg_prevent_deletion_audit_log_mutation` rejects all `UPDATE` and `DELETE` operations with PostgreSQL exception `deletion_audit_log is an append-only audit ledger: UPDATE and DELETE operations are prohibited`.
  - Table-level statement trigger `trg_prevent_deletion_audit_log_truncate` rejects `TRUNCATE` operations with `deletion_audit_log is an append-only audit ledger: TRUNCATE is prohibited`.
  - Table permissions are locked: `REVOKE TRUNCATE, DELETE, UPDATE ON "deletion_audit_log" FROM PUBLIC;`.
  - Privileged Access & Maintenance: Normal transactional `INSERT` operations are preserved for application and system services. Only PostgreSQL superusers or the database table owner (e.g. the migration administrator role) possess intrinsic PostgreSQL privileges to alter the schema or toggle triggers for emergency database repair.

- **Author Anonymization & Privacy Guarantees**:
  - `ERASE_REDDIT_AUTHOR` and `ERASE_X_AUTHOR` write an opaque, non-identifying target reference (`targetId = anon-author-<uuid>`).
  - The erased username is **strictly excluded** from `targetId`, `details`, `reasonCode`, and all audit fields, preventing dictionary-based deanonymization.
  - Legacy audit records created before migration 0047 were sanitized to opaque `anon-author-<hash>` IDs and had user keys stripped from details prior to trigger lock-in.

- **Scheduled X Retention Batch Auditing**:
  - `deleteExpiredXData()` records a `TTL_BATCH_CLEANUP` audit event in `deletion_audit_log` with `targetType: "x_retention_batch"`.
  - Accurately reports completed counts (`deletedPosts`, `deletedAuthors`, `deletedRuns`, `deletedLanes`).
  - If a batch failure occurs, a `FAILURE` outcome audit event is recorded with the partial counts actually completed prior to error, avoiding inaccurate deletion claims.
  - Strictly omits tweet content, handles, and user profiles.

- **Strict Audit Reason Code Allowlist Validation (`ALLOWED_DELETION_REASON_CODES`)**:
  - `deletion_audit_log.reason_code` is restricted to an explicit business/compliance allowlist defined in `src/lib/retentionReason.ts`:
    - `OPERATOR_DELETION`: Privileged administrative purge of content or accounts.
    - `AUTHOR_ERASURE_REQUEST`: Individual Right-to-be-Forgotten / GDPR / CCPA author erasure request.
    - `USER_REQUEST`: Customer project deletion request.
    - `ROUTINE_TTL_EXPIRY`: Scheduled automated retention expiration.
    - `ROUTINE_TTL_FAILURE`: Scheduled automated retention job failure.
    - `PROJECT_DELETION`: Customer workspace or project removal.
    - `LEGAL_COMPLIANCE`: Formal takedown or court-ordered compliance mandate.
    - `ACCOUNT_CLOSURE`: Customer account termination.
    - `DATA_MINIMIZATION`: Routine pruning of orphaned or redundant metadata.
  - All deletion workflows (`eraseRedditAuthor`, `deleteRedditPost`, `eraseXAuthor`, `deleteXPost`, `deleteProject`) pass the caller's reason through `validateDeletionReasonCode(reason, defaultCode)`.
  - Normalizes candidate strings (trims, uppercase) and checks membership in the allowlist. Arbitrary free-form text, author usernames (`@handle`), scraped quotes, bios, or unstructured user comments are strictly rejected and replaced with safe default reason codes, guaranteeing that PII cannot leak into the audit ledger via reason codes.

- **Sanitized Cleanup Failure Diagnostics**:
  - Scheduled cleanup jobs (`deleteExpiredXData`) record `TTL_BATCH_CLEANUP` audit entries on failure.
  - **Prohibition of Raw `error.message`**: Database exceptions and network errors frequently echo query parameters containing usernames or quoted text (e.g. `Failed query ... where author = 'toxic_handle'`). Storing raw `error.message` in audit `details` would violate data erasure guarantees.
  - **Allowlisted Failure Categories (`ALLOWED_FAILURE_CATEGORIES`)**: Exceptions are categorized via `categorizeCleanupError(error)` into stable classes (`DATABASE_ERROR`, `TIMEOUT_ERROR`, `CONNECTION_ERROR`, `CONSTRAINT_VIOLATION`, `INTERNAL_ERROR`).
  - Audit records write only `failureCategory`, a stable internal error code (`errorCode: "ERR_TTL_CLEANUP_FAILED"`), and safe non-identifying operational counters (`deletedPosts`, `deletedAuthors`, `cutoff`).
  - The raw exception message is strictly excluded from `details` and emitted only to access-controlled server diagnostic logs.

- **Transactional Consistency**: Deletion and audit logging share the same PostgreSQL database transaction.

## 5. Shippable Capabilities Today (Without Blocked Sources)

The following production features are fully operational, tested, and commercially clear to ship today:

1. **First-Party Customer Website Inspection & Demand Analysis**:
   - Crawling of authenticated customer domains and sitemaps.
   - Identification of missing product landing pages and demand coverage gaps.
2. **Multi-Tenant Workspaces & Project Governance**:
   - Account and project management, team collaboration, custom scoring thresholds, keyword and competitor setup.
3. **Multi-Channel Alert Infrastructure**:
   - Slack webhook integrations, email notifications, invite tokens, and alert preference management.
4. **Usage Ledger & Financial Cost Caps**:
   - Real-time spend tracking, daily house budget limits, LLM inference quotas, and billing auditability.
5. **Developer REST API & MCP Server**:
   - Authenticated endpoints (`/api/v1/projects`, `/api/v1/me`, `/api/v1/projects/:id`) with scoped API keys and rate limiting.
6. **Durable Operator Credential & Security Infrastructure**:
   - PostgreSQL-backed operator credentials, cryptographic token verification, dual-control emergency recovery, and real-time cross-worker revocation invalidation.

---

## 6. Outstanding External Commercial Actions

Technical gates are fail-closed. Commercial clearance requires completing the following external legal and administrative actions:

1. **Reddit Inc. Commercial License**:
   - Execute an enterprise Data API commercial agreement directly with Reddit Inc. covering commercial SaaS lead generation and competitor tracking.
   - Confirm permitted data retention periods, display rules, excerpt limits, and platform deletion SLAs.
2. **X Corp. Commercial Developer Agreement**:
   - Execute an official enterprise developer agreement with X Corp. (migrating from gateway proxying to official X API v2 endpoints).
3. **Google Custom Search Provisioning**:
   - Provision an official Google Cloud billing project.
   - Configure a Programmable Search Engine (CSE) and set `GOOGLE_CSE_ID` and `GOOGLE_CSE_API_KEY`.
   - Update `REC-GOOGLE-OFFICIAL-CSE` from `BLOCKED` to `APPROVED` using authorized operator credentials.

Until these contracts are executed and verified, all third-party social ingestion sources must remain **BLOCKED** and **DISABLED** in production.
