# Source Authorization Register and Data Lifecycle Audit

## 1. Executive Summary & Regulatory Context

Leystic Intent discovers buyer intent, tracks competitor dissatisfaction, identifies search rank opportunities, and maps customer demand to website coverage. Doing so requires processing public conversations and web metadata.

### Critical Legal and Architecture Principle
**Software gates and configuration checks enforce technical fail-closed behavior, but they do NOT constitute legal authorization.**
Written agreements, provider contracts, and legal assessments remain external requirements. Accessing data through a commercial API gateway (such as AnyAPI) does not imply or confer authorization from the underlying platform (such as Reddit or X).

### Authorization Status Summary

| Data Source | Access Seam / Provider | Intended Commercial Use | Current Status | Launch Blocker? |
|---|---|---|---|---|
| **Reddit** | AnyAPI Gateway (`reddit.*` SKUs) | Lead feeds, competitor intelligence, SEO tracking, alerts | **BLOCKED** | **YES (P0 Launch Blocker)** |
| **X / Twitter** | AnyAPI Gateway (`twitter.*` SKUs) | Buyer intent and reply-opportunity discovery | **BLOCKED** (Feature flag off: `X_LEADS=false`) | Conditional (off by default) |
| **Google Search (SERP)** | AnyAPI Gateway (`google.search`) | Discovery phrasing queries and SERP snippet observation | **PENDING / BLOCKED** (Downstream thread reads blocked) | Bound to Reddit status |
| **Customer Websites** | First-Party Web Crawler (`src/lib/gaps/crawler.ts`) | Demand-to-page gap analysis on customer-owned domains | **APPROVED** (First-party scoped) | No |
| **LLM Inference** | OpenRouter / Vercel AI Gateway | Lead scoring, reason categorization, brief synthesis | **APPROVED** (Subject to DPA terms) | No |

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

### 2.3 Google SERP Pipeline (via AnyAPI)

* **Endpoints & SKUs**:
  * `google.search` (`src/lib/seo/fetch.ts:googleSearch`): English US search queries formatted as `${keyword} reddit`.
* **Storage Tables**:
  * `serp_results`, `discovery_evidence`.
* **Downstream Usage**:
  * Filters Google results for Reddit URLs (`src/lib/seo/links.ts:redditResults`).
  * Passes discovered Reddit URLs to `reddit.post` for thread retrieval.
  * Downstream usage is strictly bound by Reddit authorization status.

### 2.4 First-Party Target Website Crawler

* **Mechanism**:
  * Custom HTTP/HTTPS crawler (`src/lib/gaps/crawler.ts`) with custom DNS connection pinning, private IP rejection (SSRF protection), redirect limits, and domain scoping.
* **Storage Tables**:
  * `website_inspections`, `website_pages`, `demand_page_confirmations`.
* **Downstream Usage**:
  * Maps inspected customer landing pages against buyer demand clusters to identify missing product pages or coverage gaps.

---

## 3. Source Authorization Register

### Source Register Detail Cards

#### Provider 1: Reddit Inc. (Accessed via AnyAPI Gateway)
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

#### Provider 2: X Corp. (Accessed via AnyAPI Gateway)
* **Access Method**: AnyAPI gateway proxy endpoints (`twitter.search`, `twitter.tweet`, `twitter.profile`).
* **Intended Deployment**: B2B SaaS buyer-intent identification from public tweets and replies.
* **Applicable Terms**:
  * X Developer Agreement and Policy: https://developer.x.com/en/more/developer-terms/agreement-and-policy
  * Review Date: October 2026.
* **Status**: **BLOCKED / PENDING**
* **Status Rationale**:
  * Direct X API commercial licensing is required for enterprise SaaS ingestion. Feature is currently dark (`X_LEADS=false`).
* **Required Evidence to Enable**:
  * Direct X Developer API tier contract or written provider authorization.
  * Explicit setting of `X_LEADS=true` and documented record reference `X_AUTH_RECORD_ID`.

#### Provider 3: Google Search (Accessed via AnyAPI Gateway)
* **Access Method**: AnyAPI gateway proxy (`google.search`).
* **Intended Deployment**: Discovery of public web search ranking positions for product problem phrasings.
* **Applicable Terms**:
  * Google Terms of Service: https://policies.google.com/terms
  * Review Date: October 2026.
* **Status**: **PENDING / BLOCKED** (for scraped SERP); **APPROVED** only when using official Google Custom Search JSON API with commercial billing.
* **Downstream Restriction**: Even if search phrasing rankings are retrieved, opening discovered Reddit links is blocked unless Reddit authorization is established.

#### Provider 4: Customer Website Crawler (`src/lib/gaps/crawler.ts`)
* **Access Method**: First-party HTTP/HTTPS client with socket-level IP connection pinning and strict DNS rebinding validation.
* **Intended Deployment**: Inspection of customer-owned websites configured by authenticated project owners.
* **Applicable Terms**:
  * Leystic Terms of Service (Customer Authorization of Configured URL).
  * Review Date: October 2026.
* **Status**: **APPROVED**
* **Permitted Scope**: First-party customer root URLs and sitemaps only. Disallows crawling third-party domains without owner authentication.

#### Provider 5: LLM Inference Providers (OpenRouter / Vercel AI Gateway)
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

1. **Default State**:
   * `REDDIT_SOURCE_ENABLED` defaults to `false`.
   * Without explicit configuration, all Reddit ingestion, cache reuse, and downstream serving paths fail closed.
2. **Double-Check Invariant**:
   * Setting `REDDIT_SOURCE_ENABLED=true` alone is rejected as invalid configuration.
   * An operator must also provide `REDDIT_AUTH_RECORD_ID` referencing an executed contract or verified entry in this register.
   * Placeholder values (`none`, `pending`, `test`, `todo`, `unverified`) fail closed.
3. **Execution Seam Enforcement**:
   * `src/lib/reddit/fetch.ts:fetchShared`: Checks `assertSourceAuthorized(sourceForSku(sku))` before querying `searchRuns` (blocking cache reuse) and before calling AnyAPI (blocking paid network calls).
4. **Serving Path Isolation**:
   * Feeds (`src/lib/leads.ts`), competitor reads (`src/lib/competitors/read.ts`), and SEO reads (`src/lib/seo/read.ts`) return empty results and display clear, non-misleading disabled-state notifications rather than pretending searches were performed and yielded zero results.
   * Public API endpoints (`src/lib/api/handlers.ts`) reject requests for unauthorized sources with typed error `source_disabled` (HTTP 403).
   * Alert channels (`src/lib/alerts/leads.ts`) suppress unauthorized source excerpts from being broadcast to Slack, Discord, or Email.

---

## 5. Retention and Deletion Audit Matrix

| Data Category | Table Name | Retention Period | Purpose | Deletion Mechanism | Cascade / FK Behavior | Unresolved Limitations & Upstream Constraints |
|---|---|---|---|---|---|---|
| **Reddit Posts** | `reddit_posts` | 30 days default (`RETENTION_DAYS`) | Thread context, lead evaluation, competitor mentions | `deleteExpiredPosts` (bounded batches of 500) | Cascades to `reddit_comments`, `post_readings`, `search_run_posts`, `lead_evaluations` | **Limitation**: AnyAPI provides no upstream deletion notifications. Posts deleted on reddit.com persist in Leystic unless re-fetched. Posts referenced by `leads`, `seo_opportunities`, or `competitor_mentions` are retained indefinitely past 30 days. |
| **Reddit Comments** | `reddit_comments` | Follows parent post | Lead quote context, competitor discussion quotes | `deleteExpiredPosts` via CASCADE | Foreign key to `reddit_posts` with `ON DELETE CASCADE` | Upstream deletions on Reddit cannot be detected automatically. |
| **Reddit Authors** | `reddit_authors` | Persisted indefinitely unless pruned | Public avatar, karma, account creation date | `pruneOrphanedAuthors` | **Limitation**: NO foreign key to `reddit_posts`. Deleting a post leaves the author row in `reddit_authors` indefinitely unless explicitly audited and cleaned. |
| **Subreddits** | `subreddits` | 7 days reuse cadence | Rules text, promotion policies, subscriber counts | Overwritten on re-fetch | Primary key on name, no foreign key cascade | Historical rules persist across sweeps until refreshed. |
| **Search Runs** | `search_runs` | Indefinite | Financial ledger accounting, daily house cap validation | Manual / operator purge only | Referenced by `usage_ledger`, `serp_results`, `search_run_posts` | Holds normalized query strings and request IDs; preserved for billing auditability. |
| **SERP Results** | `serp_results` | Follows search run | Discovered Google search rankings | Cascades with `search_runs` | Foreign key to `search_runs` with `ON DELETE CASCADE` | Only holds Reddit thread URLs; non-Reddit results dropped before write. |
| **Search Run Posts** | `search_run_posts` | Follows post and run | Links runs to returned post IDs | Cascades with `reddit_posts` or `search_runs` | Composite primary key `(searchRunId, postId)` | Deleted automatically when either side is removed. |
| **Leads** | `leads` | Indefinite (or until user deletes project) | High-intent customer leads shown to founders | Deleted with project cascade | Foreign key to `projects` (`ON DELETE CASCADE`), references `reddit_posts` (`ON DELETE CASCADE`) | **Limitation**: Retains associated `reddit_posts` indefinitely to prevent losing user lead history. |
| **Lead Evaluations** | `lead_evaluations` | Follows post / project | Caches candidate verdicts to prevent re-judging | Cascades with `reddit_posts` or `projects` | Foreign key to `reddit_posts` (`ON DELETE CASCADE`) | Rejected candidates are forgotten if the underlying post is pruned. |
| **Post Readings** | `post_readings` | Follows post | Product-agnostic need classification | Cascades with `reddit_posts` | Foreign key to `reddit_posts` (`ON DELETE CASCADE`) | Re-judged if post is deleted and re-discovered. |
| **Competitor Mentions** | `competitor_mentions` | 30-day display window; stored until post/project deletion | Competitor praise, complaints, and switching signals | Deleted with project cascade | Foreign key to `projects` and `reddit_posts` (`ON DELETE CASCADE`) | `deleteExpiredPosts` explicitly excludes posts referenced by competitor mentions to prevent silent cascade loss. |
| **SEO Opportunities** | `seo_opportunities` | Indefinite (refreshed periodically) | Google search ranking positions for problem phrasings | Deleted with project cascade | Foreign key to `reddit_posts` (`ON DELETE SET NULL`) | Retains associated `reddit_posts` past retention window. |
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
- **Dry-Run Audit**: Operators can run `auditRetention()` at any time to inspect row counts, retention justifications, and eligible cleanup volumes without modifying data.
- **Controlled Deletion**: Destructive cleanup of orphaned or expired records must never run as an automated unmonitored script. The scheduler runs only bounded batches (`RETENTION_BATCH = 500`).
- **Data Erasure Requests**: If an individual submits an erasure request for their Reddit username or post, the operator must execute a targeted database deletion across `reddit_posts`, `reddit_comments`, and `reddit_authors`.

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
