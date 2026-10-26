# Source Authorization Register and Data Lifecycle Audit

## 1. Executive Summary & Regulatory Context

Leystic Intent discovers buyer intent, tracks competitor dissatisfaction, identifies search rank opportunities, and maps customer demand to website coverage. Doing so requires processing public conversations and web metadata.

### Critical Legal and Architecture Principle
**Software gates and configuration checks enforce technical fail-closed behavior, but they do NOT constitute legal authorization.**
Written agreements, provider contracts, and legal assessments remain external requirements. Accessing data through a commercial API gateway (such as AnyAPI) does not imply or confer authorization from the underlying platform (such as Reddit or X).

### Authorization Status Summary

| Data Source | Access Seam / Provider | Intended Commercial Use | Current Status | Authoritative Record ID | Launch Blocker? |
|---|---|---|---|---|---|
| **Reddit** | AnyAPI Gateway (`reddit.*` SKUs) | Lead feeds, competitor intelligence, SEO tracking, alerts | **BLOCKED** | `REC-REDDIT-COMMERCIAL-UNVERIFIED` | **YES (P0 Launch Blocker)** |
| **X / Twitter** | AnyAPI Gateway (`twitter.*` SKUs) | Buyer intent and reply-opportunity discovery | **PENDING** | `REC-X-PILOT-REVIEW` | Conditional (off by default) |
| **Google Scraped SERP** | AnyAPI Gateway (`google.search`) | Discovery phrasing queries and SERP snippet observation | **BLOCKED** | `REC-GOOGLE-ANYAPI-SCRAPED` | Bound to Reddit status |
| **Google Official API** | Official Google Custom Search Engine (CSE) | Discovery phrasing queries via official API | **BLOCKED** (Unconfigured) | `REC-GOOGLE-OFFICIAL-CSE` | No |
| **Customer Websites** | First-Party Web Crawler (`src/lib/gaps/crawler.ts`) | Demand-to-page gap analysis on customer-owned domains | **APPROVED** | `REC-WEBSITE-CRAWLER-FIRST-PARTY` | No |
| **LLM Inference** | OpenRouter / Vercel AI Gateway | Lead scoring, reason categorization, brief synthesis | **APPROVED** | Multi-provider DPA | No |

---

## 2. Complete Source-Data Flow Map

### 2.1 Reddit Pipeline (via AnyAPI)

* **Endpoints & SKUs**:
  * `reddit.search` (`src/lib/reddit/skus.ts:fetchSearch`): Keyword searches sorted by relevance or new, bounded by timeframe.
  * `reddit.subreddit_posts` (`src/lib/reddit/skus.ts:fetchSubredditPosts`): Newest community post listings.
  * `reddit.post` (`src/lib/reddit/skus.ts:fetchPost`): Full thread lookup by URL / post ID.
  * `reddit.post_comments` (`src/lib/reddit/skus.ts:fetchPostComments`): Complete comment tree for a thread.
  * `reddit.subreddit_details` (`src/lib/reddit/skus.ts:fetchSubredditDetails`): Community sidebar rules, subscriber counts, weekly active users.
  * `reddit.avatar` (`src/lib/reddit/skus.ts:fetchAuthorProfile`): Public author profile metadata (avatar URL, karma, account creation date).
* **Storage Tables**:
  * `reddit_posts` (`src/db/schema/shared.ts`): Post ID, subreddit, author, title, body, URL, score, reply count, archived/locked flags, timestamps.
  * `reddit_comments` (`src/db/schema/shared.ts`): Comment ID, post ID, parent ID, author, body, score, permalink, timestamps.
  * `reddit_authors` (`src/db/schema/shared.ts`): Username, avatar URL, karma, account creation date, fetched timestamp.
  * `subreddits` (`src/db/schema/shared.ts`): Name, icon URL, subscribers, rules text, summarized self-promotion policy.
  * `search_runs` & `search_run_posts` (`src/db/schema/shared.ts`): Request IDs, normalized queries, variants, completion timestamps, cost, post links.
* **Downstream Consumers**:
  * **Lead Feed**: `leads` and `lead_evaluations` store model-judged buying intent, fit, and stage.
  * **Product Readings**: `post_readings` store product-agnostic need states and relationship classifications.
  * **Competitor Intelligence**: `competitor_mentions` store competitor praise reasons, limitation reasons, and switching evidence (`actively_switching`, `evaluating_alternatives`).
  * **SEO Tracking**: `seo_opportunities` store ranking Reddit threads mapped to search keywords.
  * **Pain Themes**: `pain_themes` clusters lead titles and bodies into recurring customer friction topics.
  * **Alerts & Integrations**: Slack, Discord, Webhooks, and Email digests send post/comment excerpts and usernames to subscribers.
  * **API & MCP**: Public API `/api/v1/projects/[id]/leads` and MCP tools (`list_leads`, `get_lead`, `list_projects`) serve post excerpts and metadata.
  * **LLM Inference**: Post titles, bodies, and comments are passed to OpenRouter (Muse) and AI Gateway (Jev) for classification.
  * **Caching Layers**: Database-backed `search_runs`, in-memory `inFlightRuns`, and `projectFeedCache`.

### 2.2 X / Twitter Pipeline (via AnyAPI)

* **Endpoints & SKUs**:
  * `twitter.search` (`src/lib/x/skus.ts:searchPage`): Search lane queries with `since_time`.
  * `twitter.tweet` (`src/lib/x/skus.ts:fetchTweet`): Conversation context and parent tweet lookup.
  * `twitter.profile` (`src/lib/x/skus.ts:fetchProfile`): Bio, followers, following, verified status.
* **Storage Tables**:
  * `x_posts`, `x_authors`, `x_search_run_posts`, `x_lanes`, `x_evaluations`, `x_leads`, `x_runs`, `x_projects`.
* **Downstream Usage**:
  * Displayed in dedicated X tab (`src/app/app/x/page.tsx`).
  * Managed under separate feature toggle `X_LEADS`.

### 2.3 Google SERP Routes

The architecture distinguishes two separate Google search mechanisms:

1. **Scraped SERP via AnyAPI (`google_scraped_serp`)**:
   * Endpoint / SKU: `google.search` (`src/lib/seo/fetch.ts:googleSearch`).
   * Access Method: Third-party scraping gateway.
   * Status: **BLOCKED** (`REC-GOOGLE-ANYAPI-SCRAPED`). AnyAPI scraping lacks direct license from Google.
   * Downstream Restriction: Passing discovered Reddit URLs to `reddit.post` is also blocked unless Reddit is authorized.

2. **Official Google Custom Search JSON API (`google_official_api`)**:
   * Access Method: Direct REST requests to Google Custom Search JSON API using dedicated Google Cloud project credentials and commercial billing.
   * Status: **BLOCKED / UNCONFIGURED** (`REC-GOOGLE-OFFICIAL-CSE`). Requires configured Google API keys and Custom Search Engine ID (CSE ID).
   * Intended Deployment: Public ranking observation for discovery keywords.

### 2.4 First-Party Target Website Crawler

* **Mechanism**:
  * Custom HTTP/HTTPS crawler (`src/lib/gaps/crawler.ts`) with custom DNS connection pinning, private IP rejection (SSRF protection), redirect limits, and domain scoping.
* **Storage Tables**:
  * `website_inspections`, `website_pages`, `demand_page_confirmations`.
* **Downstream Usage**:
  * Maps inspected customer landing pages against buyer demand clusters to identify missing product pages or coverage gaps.

---

## 3. Source Authorization Register

### Controlled Vocabulary for Purposes and Scopes

To prevent arbitrary bypass strings, purposes and scopes are restricted to controlled vocabularies:

- **Authorized Purposes (`SourceUsagePurpose`)**:
  - `commercial_lead_generation`
  - `competitor_intelligence`
  - `seo_opportunity_discovery`
  - `social_intent_monitoring`
  - `customer_website_coverage`
  - `compliance_audit`

- **Authorized Scopes (`SourceUsageScope`)**:
  - `search_discovery`
  - `social_content_read`
  - `comments_read`
  - `profile_metadata_read`
  - `customer_domain_crawl`
  - `commercial_indexing`
  - `social_intent_monitoring`
  - `read_only_audit`
  - `test_scope`

### Trusted Authorization Registry Schema & Persistent Storage

Every managed source is governed by an authoritative record in the trusted registry (`src/lib/sourcePolicy.ts`). The registry is durably backed by PostgreSQL tables created in migration `drizzle/0043_source_authorization_registry.sql` (`src/db/schema/sourceAuth.ts`):

1. **`source_auth_records` Table**:
   - `record_id`: primary key (e.g. `REC-REDDIT-COMMERCIAL-UNVERIFIED`).
   - `source_id`: text identifier (`reddit`, `x`, `google_scraped_serp`, `google_official_api`, `website_crawler`).
   - `name`: descriptive title of the agreement or gate record.
   - `status`: authoritative gate state (`PENDING`, `APPROVED`, `BLOCKED`, `EXPIRED`).
   - `authorized_purposes`: JSON array of approved `SourceUsagePurpose` values.
   - `scopes`: JSON array of approved `SourceUsageScope` values.
   - `effective_date`: UTC timestamp marking start of validity.
   - `expiration_date`: optional UTC timestamp marking expiration.
   - `evidence_reference`: pointer to external executed contract, DPA, or audit document.
   - `approval_provenance`: JSON object tracking `approvedBy`, `reviewedAt`, and `notes`.
   - `revocation_reason`: optional reason documenting why a record was blocked or expired.
   - `revoked_at` / `revoked_by`: timestamps and actor attribution for revocations.
   - `created_at` / `updated_at`: audit timestamps.

2. **`source_auth_audit_events` Table & Append-Only Guarantees**:
   - Append-only transactional audit ledger recording every administrative mutation.
   - Tracks `id`, `record_id`, `action` (`REGISTER`, `UPDATE`, `APPROVE`, `REVOKE`), `performed_by`, `actor_role` (`system_administrator`, `compliance_officer`, `legal_counsel`), `evidence_reference`, `reason`, `previous_status`, `new_status`, `details`, and `created_at`.
   - Foreign key to `source_auth_records` is configured with `ON DELETE RESTRICT`, preventing cascading deletion.
   - Enforced by database trigger `prevent_source_auth_audit_events_mutation` prohibiting `UPDATE` and `DELETE` operations on `source_auth_audit_events`.

3. **Authoritative PostgreSQL Runtime Initialization & Cross-Worker Consistency**:
   - In production (`NODE_ENV === "production"`), the registry strictly instantiates `DrizzleSourceAuthStore` (`createDefaultSourceAuthStore()`) reading from PostgreSQL. Falling back to file-backed storage in production is prohibited.
   - Hydration occurs during application server startup via `initSourcePolicyRegistry()` wired directly into `src/instrumentation.ts:register()`.
   - If the durable store fails or is unreachable, the registry marks itself unhealthy and clears the cache, failing closed immediately. No stale approved cache entries are preserved.
   - Cross-worker revocation consistency: mutations emit PostgreSQL notifications via `pg_notify('source_auth_invalidation', ...)` in the same transaction as the database write.
   - Independent worker registries establish dedicated PostgreSQL notification listeners with explicit readiness confirmation (`ready()`). Reconnection, disconnect, and socket errors synchronously invalidate the cache.
   - Bounded staleness model: cached authorizations maintain a strict maximum staleness window (`maxStalenessMs = 100ms`). In the event of missed notifications or listener partitions, operations check `ensureSourcePolicyFresh()`. If cache age exceeds the staleness threshold and the store cannot be reached, the registry fails closed immediately.

4. **Durable Operator Credentials & First-Use Bootstrap Hardening**:
   - Operator credentials are persisted durably in `operator_credentials` with append-only audit tracking in `operator_credential_audit_events`.
   - Plaintext secret tokens are never stored; verification uses SHA-256 token hashes with strict entropy requirements (minimum 32 characters).
   - Singleton bootstrap state is governed by `operator_bootstrap_state`. Initial bootstrap is strictly first-use-only and protected by PostgreSQL row-level locks (`SELECT ... FOR UPDATE`), preventing concurrent bootstrap races across workers and rejecting any repeated bootstrap attempts once initialized.
   - Emergency recovery is isolated under `emergencyRecoverOperatorCredentials`, requiring explicit operator justification, tracking durable recovery counts, and recording auditable provenance without bypassing append-only audit ledgers.

```ts
export type TrustedAuthRecord = {
  recordId: string;
  sourceId: SourceId;
  name: string;
  status: SourceAuthStatus; // "PENDING" | "APPROVED" | "BLOCKED" | "EXPIRED"
  authorizedPurposes: SourceUsagePurpose[];
  scopes: SourceUsageScope[];
  effectiveDate: string; // ISO 8601
  expirationDate: string | null; // ISO 8601 or null
  evidenceReference: string;
  approvalProvenance: {
    approvedBy: string;
    reviewedAt: string;
    notes: string;
  };
  revocationReason?: string | null;
  revokedAt?: string | null;
  revokedBy?: string | null;
  updatedAt?: string;
};

export type SourceOperationRequest = {
  sourceId: SourceId;
  purpose: SourceUsagePurpose;
  scope: SourceUsageScope;
  now?: Date;
  authRecordIdOverride?: string;
};
```

Software treats this registry as the sole source of truth. Setting an environment variable to a fabricated record ID fails closed. Software enforces that `enabled = true` only when a recognized record has status `APPROVED`, falls within valid temporal bounds, and explicitly covers the requested operation purpose and scope.

### Operator Authorization Boundary & Unblock Protection

1. **Mandatory Operator Context & Production Secret**:
   - Administrative mutations (`operatorApproveRecord`, `operatorRevokeRecord`, `operatorRegisterRecord`) require an explicit `OperatorContext`:
     * `operatorId`: non-empty verified operator identifier (anonymous identities such as "anon" are rejected in production).
     * `role`: strictly controlled role: `system_administrator`, `compliance_officer`, or `legal_counsel`.
     * `operatorKey`: in production (`NODE_ENV === "production"`), `OPERATOR_SECRET_KEY` must be configured in the environment and must match `operatorKey`. If unconfigured or mismatched, mutations fail closed with `OperatorAuthorizationError`.
   - Arbitrary runtime code, unauthenticated web requests, and background jobs cannot mutate registry state.

2. **Unblock Protection Invariants**:
   - A record currently marked `BLOCKED` or `EXPIRED` cannot be silently overwritten to `APPROVED` by a routine update.
   - Unblocking requires explicit `unblockConfirmed: true`.
   - Unblocking requires role authorization restricted to `legal_counsel` or `compliance_officer` (system administrators cannot unilaterally unblock legally revoked records).
   - Unblocking requires a new, distinct `evidenceReference` documenting the new legal basis. Re-using the prior evidence reference is rejected.

3. **Validation & Defensive Immutability**:
   - All records are validated on registration via `validateTrustedAuthRecord` (dates, non-empty IDs, purpose/scope membership).
   - In-memory registry reads return deeply cloned, frozen objects (`Object.freeze`) to prevent in-place tampering.
   - Revocation synchronously invalidates cached policy state across workers and process restarts.

4. **Acquisition Operation Context Mapping**:
   Every production source acquisition is strictly bound to its specific consuming purpose and scope via `ACQUISITION_OPERATIONS` and validated at the `operationForFetch()` seam before execution:

   | Acquisition Operation | SKU | Fetch Kind | Consuming Purpose | Required Scope |
   |---|---|---|---|---|
   | `lead_search` | `reddit.search` | `keyword` | `commercial_lead_generation` | `search_discovery` |
   | `lead_subreddit_posts` | `reddit.subreddit_posts` | `subreddit_posts` | `commercial_lead_generation` | `search_discovery` |
   | `lead_post` | `reddit.post` | `post` | `commercial_lead_generation` | `social_content_read` |
   | `lead_comments` | `reddit.post_comments` | `comments` | `commercial_lead_generation` | `comments_read` |
   | `lead_profile` | `reddit.avatar` | `profile` | `commercial_lead_generation` | `profile_metadata_read` |
   | `lead_subreddit_details` | `reddit.subreddit_details` | `subreddit` | `commercial_lead_generation` | `search_discovery` |
   | `competitor_search` | `reddit.search` | `keyword` | `competitor_intelligence` | `search_discovery` |
   | `competitor_post` | `reddit.post` | `post` | `competitor_intelligence` | `social_content_read` |
   | `seo_google_search` | `google.search` | `serp` | `seo_opportunity_discovery` | `search_discovery` |
   | `seo_post` | `reddit.post` | `post` | `seo_opportunity_discovery` | `social_content_read` |
   | `x_search` | `twitter.search` | `x_search` | `social_intent_monitoring` | `search_discovery` |
   | `x_tweet` | `twitter.tweet` | `x_tweet` | `social_intent_monitoring` | `social_content_read` |
   | `x_profile` | `twitter.profile` | `x_profile` | `social_intent_monitoring` | `profile_metadata_read` |
   | `website_crawl` | `website.crawl` | `website_crawl` | `customer_website_coverage` | `customer_domain_crawl` |

   If any acquisition path lacks explicit purpose or scope context, or if an unpermitted combination is requested, `operationForFetch()` immediately throws `SourceUnauthorizedError` and fails closed before cache or network operations.

### Authoritative Registered Records

#### Record 1: Reddit Commercial Gate (`REC-REDDIT-COMMERCIAL-UNVERIFIED`)
* **Source ID**: `reddit`
* **Access Method**: AnyAPI gateway proxy endpoints (`reddit.search`, `reddit.post`, `reddit.post_comments`, `reddit.subreddit_details`, `reddit.subreddit_posts`, `reddit.avatar`).
* **Intended Deployment**: Multi-tenant commercial B2B SaaS. Public buyer-intent extraction, competitor dissatisfaction tracking, and lead feeds displayed to paying users.
* **Applicable Terms**:
  * Reddit Data API Terms (effective July 2023, updated 2024): https://www.redditinc.com/policies/data-api-terms
  * Reddit Developer Terms: https://www.reddit.com/wiki/api-terms
  * Reddit User Agreement: https://www.redditinc.com/policies/user-agreement
  * Review Date: October 2026.
* **Status**: **BLOCKED**
* **Status Rationale**:
  * AnyAPI is an uncertified third-party gateway providing scraped or reverse-engineered Reddit data.
  * Reddit's commercial Data API Terms explicitly prohibit third-party monetization, commercial redistribution, and model-based derivation without an executed enterprise contract directly with Reddit Inc.
  * Accessing an API through a paid gateway does not grant legal copyright or licensing permissions from the platform.
* **Required Evidence to Enable**:
  * Written commercial licensing agreement executed between Leystic (operator) and Reddit Inc.
  * Documented approval reference recorded in deployment environment (`REDDIT_AUTH_RECORD_ID`).
  * Explicit confirmation of permitted retention, display, attribution, and user deletion handling.
* **Permitted Scope Until Authorized**: NONE. All requests and cache reads must fail closed.

#### Record 2: X / Twitter Pilot Review (`REC-X-PILOT-REVIEW`)
* **Source ID**: `x`
* **Access Method**: AnyAPI gateway proxy endpoints (`twitter.search`, `twitter.tweet`, `twitter.profile`).
* **Intended Deployment**: B2B SaaS buyer-intent identification from public tweets and replies.
* **Applicable Terms**:
  * X Developer Agreement and Policy: https://developer.x.com/en/more/developer-terms/agreement-and-policy
  * Review Date: October 2026.
* **Status**: **PENDING** (`enabled: false`)
* **Status Rationale**:
  * Direct X API commercial licensing is required for enterprise SaaS ingestion. Feature is currently dark (`X_LEADS=false`).
  * Under pending status, paid provider calls, cache reuse, and serving of X-derived data are strictly denied.
* **Required Evidence to Enable**:
  * Direct X Developer API tier contract or written provider authorization.
  * Execution of commercial license and updating record status to `APPROVED`.

#### Record 3: Google Scraped SERP (`REC-GOOGLE-ANYAPI-SCRAPED`)
* **Source ID**: `google_scraped_serp`
* **Access Method**: AnyAPI gateway proxy (`google.search`).
* **Intended Deployment**: Discovery of public web search ranking positions for product problem phrasings.
* **Applicable Terms**:
  * Google Terms of Service: https://policies.google.com/terms
  * Review Date: October 2026.
* **Status**: **BLOCKED**
* **Status Rationale**:
  * Third-party scraped SERP lacks a commercial license from Google.
* **Downstream Restriction**: Discovered Reddit links cannot be fetched or processed while Reddit authorization is blocked.

#### Record 4: Google Official Custom Search API (`REC-GOOGLE-OFFICIAL-CSE`)
* **Source ID**: `google_official_api`
* **Access Method**: Direct REST calls to Google Custom Search JSON API with dedicated Google Cloud billing.
* **Intended Deployment**: Keyword phrasing ranking observation via official Google APIs.
* **Applicable Terms**:
  * Google Cloud APIs Terms of Service: https://cloud.google.com/terms/service-terms
  * Review Date: October 2026.
* **Status**: **BLOCKED** (Unconfigured)
* **Required Evidence to Enable**:
  * Provisioned Google Cloud billing project, approved CSE ID, and verified API key.

#### Record 5: Customer Website Crawler (`REC-WEBSITE-CRAWLER-FIRST-PARTY`)
* **Source ID**: `website_crawler`
* **Access Method**: First-party HTTP/HTTPS client with socket-level IP connection pinning and strict DNS rebinding validation.
* **Intended Deployment**: Inspection of customer-owned websites configured by authenticated project owners.
* **Applicable Terms**:
  * Leystic Terms of Service (Customer Authorization of Configured URL).
  * Review Date: October 2026.
* **Status**: **APPROVED**
* **Permitted Scope**: First-party customer root URLs and sitemaps only. Disallows crawling third-party domains without owner authentication.

#### LLM Inference Providers (OpenRouter / Vercel AI Gateway)
* **Access Method**: API client calls to OpenRouter (`meta/muse-spark-1.3-contributor`) and AI Gateway (`typesafe-ai/jev`).
* **Intended Deployment**: Structured inference, reason extraction, and brief generation.
* **Applicable Terms**:
  * OpenRouter Terms of Service & Privacy Policy: https://openrouter.ai/terms
  * Vercel AI Gateway Terms: https://vercel.com/legal/ai-terms
  * Review Date: October 2026.
* **Status**: **APPROVED**
* **Permitted Scope**: Transient prompt processing under commercial terms prohibiting training on customer API inputs.

---

## 4. Technical Fail-Closed Source Authorization Gate

To ensure software cannot inadvertently violate authorization boundaries, the repository enforces a technical fail-closed source gate (`src/lib/sourcePolicy.ts`):

1. **Authoritative Registry Lookup**:
   * A source is enabled only if its authorization record exists in the trusted registry and is explicitly `APPROVED`.
   * Fabricated or unlisted record IDs fail closed immediately.
   * Temporal validity is enforced: `effectiveDate <= now <= expirationDate`. Expired or future-dated records evaluate to `enabled: false`.
   * Scope validation: Requested purpose must match `authorizedPurposes` and `scopes`.
2. **Double-Check Invariant**:
   * Setting an enablement flag (`REDDIT_SOURCE_ENABLED=true`, `X_LEADS=true`, `GOOGLE_SERP_SOURCE_ENABLED=true`) without an approved trusted record is rejected.
   * `enabled` is a strict logical consequence of `status === "APPROVED"`; it can never be an independent boolean that contradicts status.
3. **Execution Seam Enforcement**:
   * `src/lib/reddit/fetch.ts:fetchShared`: Calls `assertSourceAuthorized(sourceForSku(sku))` before querying `searchRuns` (blocking cache reuse) and before calling AnyAPI (blocking paid network calls).
   * SKU Mapping: `sourceForSku` maps `reddit.*`, `twitter.*`, and `google.*` SKUs. Unrecognized SKUs throw `SourceUnauthorizedError` to fail closed.
4. **Serving Path and Read Isolation**:
   * Feeds (`src/lib/leads.ts`), competitor reads (`src/lib/competitors/read.ts`), and SEO reads (`src/lib/seo/read.ts`) return empty results when Reddit is unauthorized.
   * X read queries (`src/lib/x/read.ts`) and alerts (`src/lib/alerts/leads.ts:newXLeadsSince`) return empty results when X is unauthorized.
   * UI pages (`src/app/app/x/page.tsx`, `src/app/app/sources/page.tsx`) display explicit, amber disabled-state banners explaining current authorization status instead of misleading empty sets.
   * Public API endpoints (`src/lib/api/handlers.ts`) reject requests for unauthorized sources with typed error `source_disabled` (HTTP 403).
   * Alert channels (`src/lib/alerts/leads.ts`) suppress unauthorized source excerpts from being broadcast to Slack, Discord, or Email.

### 4.1 Operator Authentication, Operation Identity, and Revocation Consistency

1. **Durable Server-Side Operator Credential Registry (`src/lib/operatorAuth.ts`, `src/db/schema/sourceAuth.ts`)**:
   * Administrative mutations (`operatorRegisterRecord`, `operatorApproveRecord`, `operatorRevokeRecord`) and credential operations (`operatorRegisterCredential`, `operatorRevokeCredential`, `operatorRotateCredential`) require verification through `verifyOperatorCredentials`.
   * Operator credentials are fully persisted in durable storage (`operator_credentials` table in PostgreSQL; `PersistentFileOperatorCredentialStore` for isolated test runs). Plaintext secrets are never stored; only cryptographic SHA-256 hashes are persisted.
   * Credential records undergo strict validation via `validateOperatorCredentialRecord()`:
     * Non-empty, trimmed `credentialId` and `operatorId` (rejecting placeholder values like `anon` or strings containing `unknown`).
     * Permitted role matching `VALID_OPERATOR_ROLES` (`system_administrator`, `compliance_officer`, `legal_counsel`). Loose type casts are rejected.
     * Well-formed 64-character lowercase hexadecimal SHA-256 hash regex (`/^[a-f0-9]{64}$/`).
     * Explicit boolean `revoked` state.
     * Revocation timestamp `revokedAt` is required and strictly validated if `revoked: true`; prohibited if `revoked: false`.
     * Expiration timestamp `expiresAt` is validated as a legitimate date string when present.
   * Secret token strength validation via `validateSecretTokenStrength()` enforces minimum 32 characters in production (16 characters in test) with entropy checks preventing trivial or repeated patterns.
   * Caller-supplied `operatorId` and `role` strings are never trusted on their own; identity and permitted roles are resolved strictly from server-side registered credentials. Role elevation attempts fail closed.
   * Constant-time comparison using `crypto.timingSafeEqual` prevents timing side-channel attacks during secret hash and master key validation. Plaintext secrets and hashes are never logged.
   * Production mode (`NODE_ENV === "production"`) never seeds default or predictable test credentials.
   * Unrestricted mutations are closed: credential registration and rotation require `system_administrator`; revocation requires `system_administrator` or `compliance_officer`. Unblocking a `BLOCKED` or `EXPIRED` record requires `legal_counsel` or `compliance_officer`.
   * Emergency bootstrapping and recovery: `bootstrapOperatorCredentials()` provisions initial administrator and compliance identities using `OPERATOR_BOOTSTRAP_KEY` with strict record validation and immutable `PROVISION` audit ledger events.
   * Dual-control master secret semantics: `OPERATOR_SECRET_KEY` acts as a mandatory deployment-level kill switch in production (missing secret fails all administrative mutations closed). When passed in context, it is verified against the environment variable using constant-time string comparison, while never overriding individual operator identity or role.
   * Test injection helpers (`__testOnlyRegisterOperatorCredential`, `__testOnlyRegisterRecord`) throw an error when executed in `NODE_ENV === "production"`.

2. **Durable Operator Credential Audit Ledger (`operator_credential_audit_events`, `drizzle/0044_operator_credentials.sql`)**:
   * Append-only audit history tracks every credential action (`PROVISION`, `REGISTER`, `ROTATE`, `REVOKE`).
   * Row-level trigger `trg_prevent_operator_credential_audit_events_mutation` blocks `UPDATE` and `DELETE`.
   * Statement-level trigger `trg_prevent_operator_credential_audit_events_truncate` (`BEFORE TRUNCATE`) blocks `TRUNCATE`.
   * SQL privileges `REVOKE TRUNCATE, DELETE, UPDATE ON "operator_credential_audit_events" FROM PUBLIC;` ensure table immutability even against direct SQL execution.

3. **Mandatory Explicit Operation Identity (`src/lib/reddit/fetch.ts`)**:
   * Every managed acquisition through `fetchShared()` requires an explicit, recognized `operationId` (`SourceOperationId`) in its operation context.
   * Production inference fallbacks have been removed.
   * `operationForFetch()` validates exact alignment across all 5 dimensions: `operationId`, `sourceId`, `sku`, `kind`, `purpose`, and `scope`.
   * Attempts by callers to override an operation's purpose or scope are rejected immediately.
   * Legacy inference is isolated to `__testOnlyInferOperationForFetch()`, which throws in production.

4. **Cross-Worker Revocation Consistency**:
   * PostgreSQL real-time invalidation: `DrizzleSourceAuthStore` and `DrizzleOperatorCredentialStore` emit `pg_notify` notifications inside mutation transactions (`source_auth_invalidation` and `operator_credential_invalidation`).
   * Invalidation listeners immediately evict stale cache entries across all worker processes upon transaction commit.
   * Bounded staleness window: `DEFAULT_MAX_STALENESS_MS = 2000` enforces regular re-hydration on all read paths even if notifications are delayed.
   * Fail-closed on failure: If the durable store is disconnected or fails validation, `storeHealthy` is marked false, caches are cleared, and all protected calls are blocked fail-closed.
   * In-memory/file simulations: `PersistentFileOperatorCredentialStore` coordinates cross-instance invalidation via a shared event bus and synchronous file modification time checks.

---

## 5. Retention and Deletion Audit Matrix

| Data Category | Table Name | Retention Period | Purpose | Deletion Mechanism | Cascade / FK Behavior | Unresolved Limitations & Upstream Constraints |
|---|---|---|---|---|---|---|
| **Reddit Posts** | `reddit_posts` | 30 days default (`RETENTION_DAYS`) | Thread context, lead evaluation, competitor mentions | `deleteExpiredPosts` (bounded batches of 500) | Cascades to `reddit_comments`, `post_readings`, `search_run_posts`, `lead_evaluations` | **Limitation**: AnyAPI provides no upstream deletion notifications. Posts deleted on reddit.com persist in Leystic unless re-fetched. Expired posts referenced by active leads, SEO, or competitor mentions retain their metadata row, but raw provider content (`title`, `body`, `raw`, `author`, `imageUrl`) is redacted under `redactExpiredProviderContent` to neutral placeholders (`[Redacted / Expired]`, `[deleted]`) to prevent indefinite survival of raw provider content. Expired posts with newer unexpired comments are preserved until all comments expire. |
| **Reddit Comments** | `reddit_comments` | Follows parent post (max 30 days) | Lead quote context, competitor discussion quotes | `deleteExpiredPosts` via CASCADE | Foreign key to `reddit_posts` with `ON DELETE CASCADE` | Upstream deletions on Reddit cannot be detected automatically. Raw body, JSON payload, and author are scrubbed past 30 days under `redactExpiredProviderContent`. |
| **Reddit Authors** | `reddit_authors` | 30 days default; pruned when orphaned | Public avatar, karma, account creation date | `pruneOrphanedAuthors` | Pruned when unreferenced by any remaining post or comment; raw API responses scrubbed after 30 days. |
| **Subreddits** | `subreddits` | 7 days reuse cadence | Rules text, promotion policies, subscriber counts | Overwritten on re-fetch | Primary key on name, no foreign key cascade | Historical rules persist across sweeps until refreshed. |
| **Search Runs** | `search_runs` | Indefinite | Financial ledger accounting, daily house cap validation | Manual / operator purge only | Referenced by `usage_ledger`, `serp_results`, `search_run_posts` | Holds normalized query strings and request IDs; preserved for billing auditability. |
| **SERP Results** | `serp_results` | Follows search run | Discovered Google search rankings | Cascades with `search_runs` | Foreign key to `search_runs` with `ON DELETE CASCADE` | Only holds Reddit thread URLs; non-Reddit results dropped before write. |
| **Search Run Posts** | `search_run_posts` | Follows post and run | Links runs to returned post IDs | Cascades with `reddit_posts` or `search_runs` | Composite primary key `(searchRunId, postId)` | Deleted automatically when either side is removed. |
| **Leads** | `leads` | Indefinite (or until user deletes project) | High-intent customer leads shown to founders | Deleted with project cascade (`deleteProject`) | Foreign key to `projects` (`ON DELETE CASCADE`), references `reddit_posts` (`ON DELETE CASCADE`) | Decoupled Retention: Lead history preserves business metadata (score, fit, intent, outcome, stage, reason) while raw provider content (`reddit_posts.body`, `matchedPhrase`) is redacted past 30 days. |
| **Lead Evaluations** | `lead_evaluations` | Follows post / project | Caches candidate verdicts to prevent re-judging | Cascades with `reddit_posts` or `projects` | Foreign key to `reddit_posts` (`ON DELETE CASCADE`) | Verbatim evidence quotes (`evidenceQuote`) are redacted past 30 days. Rejected candidates are forgotten if the underlying post is pruned. |
| **Post Readings** | `post_readings` | Follows post | Product-agnostic need classification | Cascades with `reddit_posts` | Foreign key to `reddit_posts` (`ON DELETE CASCADE`) | Verbatim quotes (`quote`) are redacted past 30 days. Re-judged if post is deleted and re-discovered. |
| **Competitor Mentions** | `competitor_mentions` | 30-day display window; stored until post/project deletion | Competitor praise, complaints, and switching signals | Deleted with project cascade | Foreign key to `projects` and `reddit_posts` (`ON DELETE CASCADE`) | Raw quotes, switching evidence, and derived summaries/explanations are scrubbed past 30 days under `redactExpiredProviderContent`. |
| **SEO Opportunities** | `seo_opportunities` | Indefinite (refreshed periodically) | Google search ranking positions for problem phrasings | Deleted with project cascade | Foreign key to `reddit_posts` (`ON DELETE SET NULL`) | Associated post raw content scrubbed past 30 days. |
| **Pain Themes** | `pain_themes` | Replaced on new theme generation | LLM-clustered customer friction themes | Replaced per project | Foreign key to `projects` (`ON DELETE CASCADE`) | Holds array of lead IDs (`lead_ids`). Lead deletion leaves orphaned IDs in array. |
| **X Posts** | `x_posts` | 30 days (`RETENTION_DAYS`) | Tweet text, author facts, metrics | `deleteExpiredXData` | Cascades to `x_evaluations`, `x_leads`, `x_search_run_posts` | Unlike Reddit, X leads do not prevent tweet deletion; stale in hours. |
| **X Authors** | `x_authors` | 30 days (`RETENTION_DAYS`) | Twitter handle bio, followers, verified status | `deleteExpiredXData` | Keyed by username | Pruned after 30 days of inactivity. |
| **X Search Runs** | `x_runs` | 90 days (`RUN_HISTORY_DAYS`) | Scan funnel metrics, query costs | `deleteExpiredXData` | Keyed by run ID | Pruned after 90 days. |
| **Website Pages** | `website_pages` | Preserved across inspection snapshots | Extracted page title, headings, canonical URL | Deleted with project or inspection cascade | Foreign key to `website_inspections` (`ON DELETE CASCADE`) | Crawled customer data is retained for coverage comparison. |

---

## 6. Deletion Detection Limitations and Requirements

### Upstream Deletion Blind Spots
1. **No Upstream Webhooks**: Reddit does not provide push notifications or webhooks when a user deletes a post, removes a comment, or deletes their account. AnyAPI acts as a pull gateway and has no knowledge of deletions until a specific URL is re-requested.
2. **Historical Data Immutability**: If a user on Reddit exercises a right to erasure (GDPR/CCPA) directly on reddit.com, third-party databases holding previously fetched copies cannot detect it automatically.
3. **Attribution & Excerpt Display**: Leystic displays excerpts (`EXCERPT_CHARS = 280`) and links to the original Reddit thread (`LEAD_URL`). If the thread is deleted, the canonical link becomes a 404, but stored excerpts remain in `reddit_posts` until the retention job runs.

### Operator Actions & Deletion Playbook
- **Distinction Between Routine TTL and Historical Purges**:
  * **Routine 30-Day TTL Expiration**: Runs automatically via the scheduler (`deleteExpiredPosts`), deleting expired unreferenced posts in bounded batches (`RETENTION_BATCH = 500`). For posts referenced by active leads, SEO opportunities, or competitor mentions, `redactExpiredProviderContent` scrubs raw provider bodies, comments, and downstream verbatim excerpts past 30 days while preserving lead metadata.
  * **Orphaned Author Pruning**: `pruneOrphanedAuthors` runs in bounded batches during routine retention, removing authors no longer referenced by any stored post or comment, and clearing raw API response JSON for authors past 30 days.
  * **Targeted Deletion Workflows (Privileged Operator Execution)**:
    * `deleteRedditPost(postId, { operatorContext })`: Privileged post deletion that cascades to downstream tables (`leads`, `lead_evaluations`, `competitor_mentions`, `reddit_comments`, `post_readings`), sets `seo_opportunities.postId = null`, prunes the author if left orphaned, and inserts an audit record into `deletion_audit_log`. Rejects calls without authorized `operatorContext`.
    * `eraseRedditAuthor(username, { operatorContext })`: Privileged author erasure that anonymizes author attribution to `[deleted]` across posts and comments, deletes the profile row in `reddit_authors`, and inserts an audit record into `deletion_audit_log`. Rejects calls without authorized `operatorContext`.
    * `deleteXPost(tweetId, { operatorContext })`: Privileged tweet deletion with cascading records and audit logging. Rejects calls without authorized `operatorContext`.
    * `eraseXAuthor(username, { operatorContext })`: Privileged X author erasure with profile deletion and audit logging. Rejects calls without authorized `operatorContext`.
    * `deleteProject(userId, projectId, { operatorContext? })`: Customer project deletion that cascades all project-associated tables in PostgreSQL while strictly preserving shared multi-tenant records (`reddit_posts`, `search_runs`) for other projects. Records customer or operator deletion in `deletion_audit_log`. Exposed publicly via `DELETE /api/v1/projects/:id`.
  * **Audit Trail Protection (`deletion_audit_log`)**: All deletion actions record safe operational metadata (`id`, `action`, `actor`, `actor_role`, `target_type`, `target_id`, `outcome`, `reason_code`, `details`, `created_at`) in `deletion_audit_log` (`operatorAuditLog` alias). Deleted body text, comment content, and personal profiles are strictly prohibited from audit logs.
  * **Historical Bulk Purge (Deferred Implementation)**: Historical bulk purges outside the routine 30-day TTL require explicit operator confirmation (`operatorApprovalConfirmed: true`). Calling without confirmation throws `OperatorApprovalRequiredError`. In the current codebase, destructive historical bulk purge execution is deferred (`isImplemented: false`, status `deferred_not_implemented`). The API truthfully reports deferred status and does not pretend that historical bulk deletion took place.
- **Dry-Run Audit & Plan**: Operators can call `auditRetention()` or `deleteExpiredPosts(now, batch, { dryRun: true })` at any time. `auditRetention()` returns a structured `RetentionDryRunPlan` including:
  * `cutoffDate`: ISO timestamp representing the 30-day cutoff threshold.
  * `eligiblePostsToDelete`: count of expired posts without references.
  * `preservedReferencedPosts`: breakdown of preserved posts referenced by `leads`, `seoOpportunities`, and `competitorMentions`.
  * `routineTtlCleanup`: confirms automatic 30-day bounded batch (500) TTL cleanup runs without operator approval while preserving referenced rows (with content redacted to `[Redacted / Expired]`).
  * `historicalBulkPurge`: confirms destructive bulk or historical purges are gated by code requiring explicit operator approval (`operatorApprovalConfirmed: true`), throwing `OperatorApprovalRequiredError` if unconfirmed, and reports `isImplemented: false` with status `deferred_not_implemented`.
  * `destructivePurgeBlockedWithoutOperatorApproval: true`: confirmation that destructive purging is prevented.
- **Controlled Deletion**: Destructive cleanup of orphaned or expired records must never run as an automated unmonitored script. The scheduler runs only bounded batches (`RETENTION_BATCH = 500`).
- **Data Erasure Requests**: If an individual submits an erasure request for their Reddit username or post, the operator executes `deleteRedditPost` or `eraseRedditAuthor` with their authenticated operator credential.

---

## 7. Required Evidence Before Reddit Source Can Be Activated

Commercial Reddit ingestion cannot be turned on until all of the following requirements are satisfied:

1. **Executed Commercial Contract**: A signed commercial agreement with Reddit Inc. authorizing third-party SaaS redistribution, lead scoring, and competitor intelligence.
2. **Approved Data Scope**: Written confirmation detailing permitted storage duration, excerpt character limits, and caching policies.
3. **Deletion Compliance Protocol**: A technical mechanism or operational SLA to process platform deletion and privacy requests.
4. **Environment Verification**:
   - `REDDIT_SOURCE_ENABLED=true`
   - `REDDIT_AUTH_RECORD_ID="<VALID_CONTRACT_IDENTIFIER>"` (e.g., `DOC-REDDIT-2026-COMMERCIAL-001`)
   - Operator sign-off recorded in this register.
