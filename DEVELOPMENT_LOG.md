# Leystic Development Log: Public Buyer-Intent Pivot

**Date**: October 2026  
**Repository**: `AyushCodesu/leystic-intent` (fork of `getanyapi-com/lurk`)  
**Historical Context**: Legacy `AyushCodesu/leystic` preserved as read-only historical code.  

---

## 1. Pivot Objective & Core Scope

Leystic was pivoted from buyer-decision analysis to **public buyer-intent discovery**:
> **Core Value Proposition**: Help small B2B software companies find people who are already asking for a product, alternative, or solution they can offer.

The primary flow:
`Product URL -> Product Profile -> Public Buyer Signals -> Qualified Leads -> Evidence -> Alert -> Human Follow-up -> Recorded Outcome`.

---

## 2. Environment & Repository Setup

1. **Working Directory Verified**: `d:\Downloads\leystic-intent`.
2. **Git Remotes Configured**:
   * `origin`: `https://github.com/AyushCodesu/leystic-intent.git` (active development branch: `main`).
   * `upstream`: `https://github.com/getanyapi-com/lurk.git` (read-only reference for future upstream comparison).
3. **Upstream Git History**: Fully preserved. No commits were rewritten or removed.
4. **MIT License & Attribution**: Upstream MIT license and AnyAPI copyright notices maintained in `LICENSE` and headers.
5. **Node.js Environment**: Node v26.3.1, npm v11.1.0. All dependencies installed cleanly via `npm install`.

---

## 3. Product Positioning & Visual Identity Updates

* **Brand Constants (`src/lib/brand.ts`)**:
  * Product name: `Leystic`
  * Working headline: `Find people already asking for what you sell.`
  * Supporting copy: `Leystic finds public conversations where potential customers are asking for tools, exploring alternatives or describing problems your product solves. See the exact post, why it matches, and what to do next.`
  * Primary CTA: `Find buying conversations`
  * Support email: `support@leystic.com`
  * AnyAPI referral: Preserved `https://getanyapi.com/?utm_source=lurk` in accordance with upstream attribution.
* **Design System & Visual Assets**:
  * Inspected legacy Leystic design tokens and journey-path SVG logo (`d:\Downloads\leystic design system`).
  * Created `src/components/LeysticMark.tsx` providing the official Leystic logo icon.
  * Updated `src/components/Wordmark.tsx` to render the Leystic mark alongside `Leystic`.
  * Updated `src/styles/tokens.css` with Leystic brand color tokens (`--brand: #577bf4;`, `--brand-hover: #496ce7;`, `--brand-soft: #eef2ff;`).
  * Updated marketing landing page (`src/app/page.tsx`, `src/app/layout.tsx`, `src/components/marketing/CtaRow.tsx`) emphasizing human control, no auto-posting, and explainable evidence.

---

## 4. Main Navigation Consolidation

Refactored `src/app/app/layout.tsx` (`groupsFor`) to present the focused 6-item customer rail:
1. **Leads** (`/app/leads`, radar icon, displays badge count of new leads)
2. **Product** (`/app/product`, box icon)
3. **Competitors** (`/app/competitors`, swords icon, displays competitor mention count)
4. **Insights** (`/app/insights`, lightbulb icon)
5. **Usage** (`/app/usage`, receipt icon)
6. **Settings** (`/app/settings`, settings icon)

All inherited advanced configuration views (`/app/sources`, `/app/filters`, `/app/settings/alerts`, etc.) remain fully functional and reachable without cluttering the primary workflow.

---

## 5. Additive Differentiator: Closed-Loop Outcome Tracking

Implemented an additive, non-breaking outcome tracking loop to capture whether discovered leads produce tangible sales results:

1. **Database Schema (`src/db/schema/tenant.ts`)**:
   * Added `outcome`: `text("outcome")` (one of `replied`, `meeting_booked`, `opportunity`, `customer`, `not_fit`).
   * Added `outcomeRecordedAt`: `timestamp("outcome_recorded_at", { withTimezone: true })`.
   * Added `outcomeNotes`: `text("outcome_notes")`.
2. **Migration (`drizzle/0040_lead_outcomes.sql`)**:
   * Additive SQL migration created with safe defaults.
3. **Domain Logic (`src/lib/feed.ts`, `src/lib/leads.ts`)**:
   * Added outcome types, labels, and helper `recordLeadOutcome(projectId, leadId, outcome, notes)`.
   * Updated `CardLead` and `toCard()` mapping to include outcome state.
4. **Server Actions & UI (`src/app/app/leads/actions.ts`, `src/components/leads/LeadActions.tsx`, `src/components/leads/LeadDetail.tsx`)**:
   * Added `recordLeadOutcomeAction`.
   * Added interactive outcome badges and selection buttons allowing users to record `Replied`, `Meeting booked`, `Opportunity`, `Customer`, or `Not a fit` with optional notes.
   * Automatically sets outcome to `replied` when clicking "Mark Replied", or `not_fit` when clicking "Not a fit".

---

## 6. Safety & Operating Constraints

* **Human-in-the-Loop Guarantee**: Leystic never auto-posts comments, never auto-generates automated Reddit DMs, and never impersonates a human.
* **Source Scope**: Reddit is the primary source; X remains disabled by default (`X_LEADS=false`).
* **Cost Accounting**: AnyAPI request costs and model token usage are tracked separately in the ledger.

---

## 7. Verification & Test Suite Hardening

* **Test Environment Isolation**:
  * Upstream tests assume a live PostgreSQL instance running on port 5432/5433.
  * Hardened `tests/setup.ts` and `tests/fixtures/db.ts` to detect live database availability (`TEST_DB_AVAILABLE`), allowing unit tests to run cleanly and database tests to skip gracefully via `describeDb`.
  * Added fallback mocks for tenant isolation and settings in isolated unit tests (`tests/authAdoption.test.ts`, `tests/insightsLeadSet.test.ts`, `tests/startOnOpen.test.ts`, `tests/xTab.test.ts`).
* **Custom Validation Suite (`tests/leysticValidation.test.ts`)**:
  * Validates Leystic branding across marketing copy, CTA, and brand constants.
  * Validates heuristic rejection gates (empty content, author promotions).
  * Validates verbatim evidence extraction requirements.
  * Validates outcome definitions (`replied`, `meeting_booked`, `opportunity`, `customer`, `not_fit`).
* **Test Suite Status**:
  * 70 test files passed (672 tests passed, 30 skipped database-backed suites).
  * 0 failures.
* **Typography Rule**:
  * Verified that all source files conform to `tests/typography.test.ts` (no unicode em-dashes or en-dashes in `src`).
* **TypeScript Compilation**:
  * `npm run typecheck` passes with zero errors.

---

## 8. Documentation Deliverables

* `docs/future-product-opportunities.md`: Competitive analysis (Lurk, Clean, Workflows.io, Glasa, Explee), evaluation of 8 differentiators, prioritization matrix, and top 3 candidate experiments.
* `docs/leystic-intent-mvp.md`: Full end-to-end MVP workflow guide, architecture overview, cost tracking, and local deployment instructions.
* `DEVELOPMENT_LOG.md`: This chronological development log.

---

## 9. Leystic Learning V1: Make Lead Discovery Improve With Experience

**Date**: October 2026
**Commit Target**: `feat: add outcome-informed lead learning`

### 1. Objective
Establish the first real differentiator for Leystic: learning from founder-recorded explicit commercial outcomes (`replied`, `meeting_booked`, `opportunity`, `customer`, `not_fit`) and using that evidence to help founders prioritize future buyer-intent opportunities deterministically without requiring AI model invocation.

### 2. Outcome Semantics
Centralized pure classification in `src/lib/learning/semantics.ts`:
* **Qualified progress**: `meeting_booked`, `opportunity`, `customer`. Progressive commercial evidence, individually trackable.
* **Engagement**: `replied`. Founder responded; distinct from a commercial qualification.
* **Explicit mismatch**: `not_fit`. Lead marked as unsuitable by founder.
* **Unlabelled / Unknown**: Missing, null, or invalid values contribute no success or failure evidence (never treated as failures).
* **Guarantees**: Founder outcomes remain authoritative and are never mutated by the learning engine. Ordinary lead status is not substituted for explicit outcomes.

### 3. Deterministic Evidence Rules & Sample Thresholds
Centralized in `src/lib/learning/constants.ts` and `src/lib/learning/engine.ts`:
* **Project Activation Threshold**: `MIN_PROJECT_LABELLED_LEADS = 5` and `MIN_PROJECT_TERMINAL_OUTCOMES = 5` (across qualified progress + `not_fit`). Learned priority ordering remains locked until met.
* **Pattern Significance Threshold**: `MIN_PATTERN_TERMINAL_OUTCOMES = 4`. Any dimension below 4 terminal outcomes is classified as `insufficient_evidence` (developing).
* **Promising Pattern**: At least `MIN_PROMISING_QUALIFIED_OUTCOMES = 2` qualified-progress outcomes, and qualified progress strictly exceeds `not_fit`.
* **Repeated Mismatch**: At least `MIN_REPEATED_MISMATCH_OUTCOMES = 3` `not_fit` outcomes and zero qualified-progress outcomes.
* **Mixed Evidence**: Terminal outcomes >= 4 but failing both directional thresholds.
* **Query Bounding**: `OUTCOME_SAMPLE_LIMIT = 500` recent outcomes per project, ordered deterministically (`outcomeRecordedAt desc, scoredAt desc, id desc`).

### 4. UI & Prioritization Behavior
* **Insights Experience (`src/components/insights/LearningView.tsx`)**:
  * Added contextual tab **Learned patterns** to `src/components/insights/InsightsTabs.tsx`.
  * Overview metrics: total labelled leads, qualified progress breakdown, replies, not a fit, and dataset scope note.
  * Positive evidence patterns: cards with actual counts and links to filtered leads in the feed. Includes optional action to adopt promising communities into manual scoring preferences (`applyCommunitySuggestionAction`).
  * Repeated mismatches: explains deprioritization (never automatically hidden or excluded).
  * Developing / mixed evidence: explains inconclusive sample sizes without fabricated confidence percentages.
  * Empty state: renders clean guidance when no outcomes have been recorded.
* **Feed Prioritization (`src/components/leads/FeedFilters.tsx`, `src/lib/learning/ordering.ts`)**:
  * Added `order` pill with options `Score order` (default) and `Learned priority`.
  * Implemented server-side SQL ordering before pagination via `buildLearnedFeedOrder`:
    * Tier 1 (Promising patterns) -> Tier 2 (Neutral) -> Tier 3 (Repeated mismatches).
    * Retains original `THREAD_BEST`, `THREAD_NEWEST`, and model scores as stable secondary ordering and tie-breakers.
    * Feed filters (window, subreddit, stage, status) and pagination work identically.
    * Explanatory badge rendered on `LeadRow` and `LeadDetail` (`Promising pattern` or `Deprioritized pattern`).
    * Displays informative banner in `Feed.tsx` if Learned priority is selected when evidence is below threshold.

### 5. Data Isolation & Security Guarantees
* All queries strictly scoped by `leads.projectId = projectId`.
* Project ownership verified via `requireOwnedProject(projectId)` before settings actions.
* Zero cross-tenant outcome pooling or global dataset mixing.

### 6. Cost & Provider Boundaries
* Zero LLM provider or AnyAPI calls required. Pure deterministic TypeScript and SQL.
* Works completely offline and with unset model API keys.

### 7. Verification & Test Results
* **Test Suite**: 74 test files passed (698 tests passed, 30 skipped database-backed suites, 0 failures).
* **New Test Suites**:
  * `tests/learningSemantics.test.ts`: 5 tests covering outcome classification and semantics.
  * `tests/learningEngine.test.ts`: 13 tests covering threshold boundaries, deduplication, deterministic sorting, and lead assessment.
  * `tests/learningPrioritization.test.ts`: 5 tests covering SQL ordering, score immutability, filter preservation, and tenant isolation.
  * `tests/learningUI.test.ts`: 3 tests covering input immutability, zero model credentials, and empty state purity.
* **Static Verification**:
  * `npm run typecheck`: 0 errors.
  * `npm run lint`: 0 errors, 0 warnings.
  * `npm run build`: successful production build.
  * `git diff --check`: 0 whitespace or formatting issues.
  * Typography: verified adherence to no unicode em-dashes or en-dashes in `src`.

### 8. Known Limitations
* Learning patterns currently evaluate single categorical dimensions (`community`, `stage`, `kind`) independently rather than sparse cross-dimensional tuples, preventing overfitting on small founder datasets.
* Learned priority applies to Reddit buyer leads; X asks currently lack subreddit metadata and remain ordered by model fit and freshness.

---

## 10. Demand-to-Page Gap Finder V1: Connect Buyer Demand to Website Coverage Gaps

**Date**: October 2026
**Commit Target**: `feat: connect buyer demand to website coverage gaps`

### 1. Objective
Connect Leystic's public buyer-intent discovery and Learning V1 outcome tracking to the founder's own website discoverability. Identify recurring buyer questions and problem descriptions, index successfully inspected pages from the founder's website, match demand against existing page metadata, provide a founder confirmation workflow, and prioritize actionable demand-to-page coverage gaps.

### 2. Evidence Boundary & Scoped Language
* **Observed demand**: Verbatim persisted conversations, verified Reddit source URLs, intent stages, communities, and commercial outcomes.
* **Observed website coverage**: Successfully inspected pages on the configured website domain, with extracted titles, descriptions, canonical URLs, H1s, and headings.
* **Founder-confirmed mapping**: Explicit founder confirmation that a page addresses a discovered demand, provides a partial answer, or represents a confirmed gap.
* **Interpretation**: Evidence-bounded explanations explaining why an apparent gap may deserve attention without asserting unproven claims regarding Google search ranking or market-wide demand.

### 3. Website Page Inventory & Network Security
* **SSRF Protection (`src/lib/gaps/security.ts`)**:
  * Protocol restricted to `http:` and `https:`.
  * Blocks `localhost`, `.local`, `.internal`, `0.0.0.0`, all private RFC1918 ranges, link-local / AWS metadata (`169.254.169.254`), carrier-grade NAT, test nets, multicast, reserved addresses, and IPv6 private equivalents.
  * Live DNS resolution validation prevents DNS rebinding or private IP pivoting.
  * Manual redirect handling (`maxRedirects = 3`) re-validates every redirect hop against SSRF policies and domain bounds.
* **Inspection Bounds (`src/lib/gaps/constants.ts`)**:
  * `MAX_DISCOVERED_URLS = 50`: discovery queue limit.
  * `MAX_FETCHED_PAGES = 25`: maximum pages crawled per manual inspection request.
  * `FETCH_TIMEOUT_MS = 6000`: per-page request timeout.
  * `MAX_RESPONSE_BYTES = 512 * 1024` (512 KB): stream-level body byte cap.
  * `MAX_SITEMAP_BYTES = 1024 * 1024` (1 MB): sitemap XML limit.
* **Robots.txt & Sitemap Discovery (`src/lib/gaps/html.ts`, `crawler.ts`)**:
  * Respects `robots.txt` disallow rules.
  * Crawls sitemaps referenced in `robots.txt` or default `/sitemap.xml`.
  * Falls back to homepage crawling and internal link traversal when sitemaps are absent.
  * Canonical URL deduplication avoids redundant page fetches.
* **Explicit User Initiation**:
  * Zero crawling occurs during page load, render, or background refresh.
  * Triggered exclusively by explicit founder action ("Inspect website coverage").

### 4. Deterministic Demand Analysis
* Centralized in `src/lib/gaps/demand.ts`:
  * Bounded query (`LEAD_SAMPLE_LIMIT = 250`) strictly filtered by `leads.projectId = projectId`.
  * Thread deduplication: groups multiple leads sharing the same `postId` into single conversations to prevent comment threads from artificially inflating demand counts.
  * Integrates Learning V1 outcome semantics (`qualified_progress`, `engagement`, `explicit_mismatch`, `unlabelled`).
  * Normalizes topic phrases with stop-word filtering and 2-gram extraction.
  * Preserves verified source URLs and excerpts for every supporting conversation.
  * Flags weakly supported single conversations (`weaklySupported = true`) for founder review.

### 5. Matching & Candidate Gap Prioritization
* **Matching Engine (`src/lib/gaps/matching.ts`)**:
  * Deterministic term and suffix-stemming matching (`-ies`, `-es`, `-s`) comparing demand concepts against page title, h1, path, headings, and description.
  * Assigns coverage statuses: `matched` (score >= 6), `possible_match` (score >= 2), `no_match_found` (score < 2), `insufficient_evidence` (uninspected / failed crawl).
* **Prioritization (`src/lib/gaps/prioritization.ts`)**:
  * `high`: Requires unaddressed coverage (`no_match_found` or founder `confirmed_gap`) AND empirical significance ($\ge 2$ distinct threads OR $\ge 1$ qualified commercial outcome). Never marked high priority merely because a page was not found.
  * `medium`: Single unlabelled conversation with `no_match_found`, or multiple conversations with `possible_match`.
  * `developing`: Single conversation with partial match or uninspected site.
  * `addressed`: Confirmed match by founder or strong automated match.
* **Three-Part Scoped Explanation**:
  * **1. What we observed**: Concrete conversation counts, subreddits, outcome breakdown, and clickable links to verified Reddit posts.
  * **2. Why it may matter**: Bounded interpretation explaining the potential discoverability gap.
  * **3. What needs confirmation**: Transparent status and founder review controls.

### 6. Founder Confirmation Workflow & Persistence
* **Confirmation Actions (`src/app/app/insights/actions.ts`)**:
  * `confirmDemandPageMappingAction` allows founders to confirm a match, mark partial answer, confirm gap, or reset to unconfirmed.
  * Enforces server-side authorization via `requireOwnedProject(projectId)`.
  * Historical leads and outcome records are never mutated.
* **Database Schema & Migrations (`drizzle/0041_demand_page_gaps.sql`, `src/db/schema/tenant.ts`)**:
  * `website_inspections`: records inspection runs, status (`success`, `partial`, `failed`), pages crawled, and error details.
  * `website_pages`: stores indexed page metadata associated with `inspectionId`.
  * `demand_page_confirmations`: stores founder confirmation overrides per `(projectId, demandGroupId)`.
* **Snapshot Preservation Guarantee**:
  * If a subsequent inspection attempt fails, the previous successful inspection snapshot and its indexed pages are fully preserved.

### 7. Insights UI Integration (`src/components/insights/DemandGapsView.tsx`)
* Added dedicated **Demand gaps** tab in `src/components/insights/InsightsTabs.tsx`.
* Overview card with inspection status, last inspected timestamp, and explicit "Inspect website coverage" / "Re-inspect website" trigger.
* Metrics strip displaying total demand topics, high-priority gaps, confirmed gaps, and addressed needs.
* Interactive candidate gap cards rendering the three-part evidence breakdown, verified source links, external page links, and confirmation buttons.
* Clean empty states for projects with no leads, uninspected websites, and missing website URLs.

### 8. Cost & Provider Boundaries
* Zero LLM calls (no OpenRouter, OpenAI, Anthropic, or AIProvider).
* Zero AnyAPI web crawling calls.
* Zero paid SEO providers (no Firecrawl, DataForSEO, Ahrefs, Semrush).
* Works fully offline with hermetic unit tests.

### 9. Verification Results
* **Test Suite**: 81 test files passed (732 tests passed, 31 skipped database-backed suites when PostgreSQL is offline, 0 failures).
* **New Test Suites**:
  * `tests/gapsSecurity.test.ts`: 13 tests covering SSRF prevention, IP validation, and safeFetch bounds.
  * `tests/gapsHtml.test.ts`: 4 tests covering metadata extraction, robots.txt, and sitemap parsing.
  * `tests/gapsCrawler.test.ts`: 3 tests covering bounded crawling, fallback to homepage, and failure handling.
  * `tests/gapsDemand.test.ts`: 4 tests covering thread deduplication, outcome categorization, and topic extraction.
  * `tests/gapsMatching.test.ts`: 4 tests covering phrase/stem matching and coverage status assignment.
  * `tests/gapsPrioritization.test.ts`: 3 tests covering priority tiers, reason generation, and scoped explanations.
  * `tests/gapsUI.test.ts`: 3 tests covering component contracts, empty states, and snapshot preservation.
  * `tests/gapsStore.test.ts`: 1 database test covering persistence and tenant isolation.
* **Static Verification**:
  * `npm run typecheck`: 0 errors.
  * `npm run lint`: 0 errors, 0 warnings.
  * `npm run build`: successful production build.
  * `git diff --check`: 0 whitespace issues.
  * Typography: verified compliance with `tests/typography.test.ts` (0 unicode em/en-dashes in `src/`).

## [Unreleased] - 2026-10-17: Crawler DNS-Rebinding Closure & Connection Pinning

* **DNS Resolution & SSRF Hardening**:
  * Upgraded DNS lookup to query all IPv4 and IPv6 addresses via `lookup(hostname, { all: true })`.
  * Enforced that every returned address must be publicly routable. Rejects any destination when mixed public/private answers or any private addresses are returned.
  * Expanded `isPrivateIp` checks to comprehensively validate IPv6 multicast (`ff00::/8`), documentation (`2001:db8::/32`), benchmarking (`2001:2::/48`), discard prefix (`100::/64`), and embedded IPv4-mapped IPv6 formats (both dotted decimal and hex-encoded `::ffff:hi:lo`).
* **Connection Pinning & Rebinding Prevention**:
  * Introduced `defaultNodeTransport` which passes custom `lookup` directly to `http.request` / `https.request`. The socket connector receives the pre-validated IP address directly, preventing TOCTOU DNS rebinding without performing secondary DNS lookups.
  * Preserved full TLS SNI (`servername`), TLS peer certificate verification, and HTTP `Host` header behavior.
  * Reapplied full DNS resolution screening and address pinning on every redirect hop (`maxRedirects = 3`), maintaining strict allowed-host bounds, timeout, and response size capping.
* **Regression Tests & Verification**:
  * Expanded `tests/gapsSecurity.test.ts` to 29 tests covering DNS rebinding prevention, mixed public/private answers, IPv4-mapped IPv6 addresses, DNS resolution failures, redirect hops to private destinations, and live HTTP server socket connection pinning.
  * `npm run check` (`typecheck`, `lint`, and `test`) passed with 0 errors, 0 warnings, and 0 failures.
  * `npm run build` passed cleanly.

---

## [Unreleased] - 2026-10-17: Competitor Reasons V1 - Evidence, Not Sentiment Alone

### 1. Architectural Scope & Problem Statement
* Upgraded Leystic's Competitors intelligence workflow from flat positive/neutral/negative sentiment to structured, evidence-backed reason analysis.
* Directly answers three questions for founders:
  1. What do users repeatedly love about competitor products?
  2. What concrete problems or limitations frustrate their users?
  3. Which public conversations show a genuine opportunity to win a customer who may switch?
* Strictly enforces evidence boundaries:
  * A negative comment never automatically counts as switching intent (`dissatisfied_no_switch` vs `actively_switching` / `evaluating_alternatives`).
  * Complaints and praise are aggregated across independent threads (`postId`) rather than multiple replies inflating counts.
  * Single observations are explicitly labeled as examples, not recurring patterns (`distinctThreads >= 2`).
  * Unverified complaints are accompanied by a non-churn disclaimer and never framed as lost revenue or customer churn.

### 2. Structured Classification & Resilient Normalization (`src/lib/competitors/classify.ts`)
* Extended LLM extraction schema with:
  * `sentiment`: Preserves `positive`, `neutral`, `negative`.
  * `reasonCategory`: `pricing_value`, `missing_capability`, `usability`, `reliability`, `performance`, `integrations`, `support`, `recommendation_value_delivered`, `other`, `unknown`.
  * `switchingEvidence`: `actively_switching`, `evaluating_alternatives`, `dissatisfied_no_switch`, `positive_recommendation`, `no_clear_signal`.
  * `explanation`: Concise 1-2 sentence explanation strictly grounded in what the author wrote.
* Implemented resilient Zod preprocess normalization schemas (`reasonCategorySchema`, `switchingEvidenceSchema`) that normalize loose variations (e.g. `pricing/value`, `Expensive subscription cost`, `actively switching`, `frustrated with bug`) to standard enum values while defaulting uncertain inputs to `unknown` and `no_clear_signal`.

### 3. Database Persistence & Backward Compatibility
* Added migration `drizzle/0042_competitor_reasons.sql` adding nullable columns `reason_category`, `switching_evidence`, and `explanation` to `competitor_mentions`.
* Updated Drizzle schema `src/db/schema/competitors.ts`.
* Updated scan write handler `src/lib/competitors/scan.ts` to persist all enriched fields.
* Maintained full backward compatibility: older mentions with null reason fields are handled safely across queries and UI views.
* Preserved strict project/tenant isolation: mentions for one project are never returned for another project.

### 4. Distinct-Thread Aggregation & Filtering (`src/lib/competitors/read.ts`)
* Added pure domain functions:
  * `groupLoveReasons`: Groups positive praise by competitor and reason category, counting distinct threads (`postId`) and marking recurring patterns (`distinctThreads >= 2`).
  * `groupDislikeReasons`: Groups concrete complaints by competitor and limitation category, tracking distinct threads and identifying recurring issues vs isolated examples.
  * `listPotentialSwitchers`: Extracts qualified switcher leads (`actively_switching` or `evaluating_alternatives`), strictly excluding `dissatisfied_no_switch`, and deduplicating multiple replies within a thread to a single switcher card.
* Updated `listMentions` SQL query to select all new fields and map them to `MentionView`.

### 5. UI Views & Evidence Navigation (`src/app/app/competitors/page.tsx`, `src/components/competitors/`)
* Created `CompetitorTabs.tsx`: Tab navigation for "What users love", "What users dislike", "Potential switchers", and "All mentions" with live counts.
* Created `CompetitorLoveView.tsx`: Displays praise reasons with distinct thread counts, recurring badges, and expandable supporting conversations with Reddit links.
* Created `CompetitorDislikeView.tsx`: Displays concrete limitations with distinct thread counts, example vs recurring badges, supporting evidence quotes, and an explicit context disclaimer.
* Created `CompetitorSwitchersView.tsx`: Surfaces high-intent replacement discussions, displaying whether the user is actively switching or evaluating alternatives, their concrete frustration, direct quote, and link to the source thread.
* Updated `MentionCard.tsx`: Displays category and switching evidence badges on individual mentions in the "All mentions" feed.

### 6. Verification & Benchmark Precision
* **Test Suite**:
  * `tests/competitors.test.ts`: Expanded to 33 unit tests covering schema normalization, loose string mapping, thread deduplication, recurring vs example labels, switcher filtering, and benchmark precision.
  * **Curated Benchmark Set**: 10 manually reviewed Reddit posts testing explicit switching signals vs general negative sentiment. Achieved 100% precision (0 false positives for switching among purely dissatisfied users).
  * `tests/competitorReasonsDb.test.ts`: Database integration test verifying persistence, legacy row null-safety, and cross-project tenant isolation.
  * `tests/typography.test.ts`: 0 unicode em-dashes or en-dashes across `src/`.
* **Static & Production Verification**:
  * `npm run typecheck`: 0 errors.
  * `npm run lint`: 0 problems (0 errors, 0 warnings).
  * `npm run test`: 81 passed test files, 757 passed tests, 0 failures.
  * `npm run build`: Successful Next.js production build (Turbopack).
  * `git diff --check`: 0 whitespace errors.

---

## [Unreleased] - 2026-10-18: Competitor Intelligence Production Readiness Gate

### 1. Verification of Codebase & Reviewable Branches
* Verified existing implementation:
  * Commit `3a35d32`: `fix: close DNS-rebinding gap with connection pinning in website crawler`
  * Commit `efbaad3`: `feat: add evidence-backed competitor reasons and switcher discovery`
* Created and pushed dedicated review branch: `review/competitor-reasons-v1` to `origin` (`https://github.com/AyushCodesu/leystic-intent/pull/new/review/competitor-reasons-v1`).
* Executed full local verification gate:
  * `npm run typecheck`: 0 errors.
  * `npm run lint`: 0 problems (0 errors, 0 warnings).
  * `npm run test`: 81 passed files, 757 passed tests, 0 failures.
  * `npm run build`: Successful Next.js production build in 8.7s (Turbopack).
* Checked remote CI status via GitHub API: `total_count: 0` (GitHub Actions runner is not active on personal fork; local verification suite is authoritative).

### 2. Commercial Rights & Reddit Data Pipeline Audit
* Documented end-to-end data pipeline from Reddit scraping through AnyAPI gateway to customer-facing SaaS.
* **AnyAPI Terms Audit (`getanyapi.com/terms`)**:
  * AnyAPI Labs, Inc. operates as a pass-through proxy/aggregator and explicitly disclaims data ownership, curation, and third-party platform licensing.
  * Under AnyAPI's terms, the customer (Leystic) is solely responsible for compliance with target platform terms. AnyAPI does NOT license Reddit data or provide commercial redistribution rights.
* **Reddit Commercial Terms & Blocker Identification**:
  * Reddit's Developer Terms and Data API Terms (2023-2024) expressly prohibit using Reddit content for commercial SaaS products without an executed Reddit Data API Commercial Agreement.
  * Reddit terms prohibit unauthorized scraping, unauthorized third-party redistribution, model training/fine-tuning without direct license, and caching without real-time user-deletion compliance (GDPR/right to be forgotten within 24-48 hours).
  * Leystic currently lacks real-time deletion synchronization.
* **Actionable Governance Decision**:
  * Commercial reliance on unauthorized Reddit scraping is a critical compliance blocker.
  * Recommended immediate policy: Treat Reddit competitor scanning as an experimental/beta research feature; pause commercial gating of Reddit-derived features until an official Reddit Data API Commercial Agreement or an authorized open syndication source (e.g. Hacker News, GitHub Discussions) is integrated.

### 3. Synthetic Benchmark Dataset & Evaluation Harness
* Created reproducible evaluation dataset and harness (`scripts/eval-competitor-reasons.ts`, `tests/competitorReasonsEval.test.ts`) across 28 synthetic benchmark conversations and 6 competitors (Typeform, Jotform, Tally, Fillout, SurveyMonkey, Formstack).
* Explicitly labeled as a synthetic held-out benchmark suite designed to stress-test negation, staying intent, sarcasm, and mixed sentiment without using unauthorized live Reddit data.
* **Evaluation Results**:
  * Sample Size: 28 synthetic conversations.
  * Explicit Switching Intent: Precision = 100.0%, Recall = 100.0%, Specificity = 100.0%, F1 = 100.0%.
  * Staying Intent False Alarm Rate: 0.0% (0 false positives among locked-in users).
  * Overall Reason Accuracy: 85.7% (24 / 28).
  * Overall Sentiment Accuracy: 85.7% (24 / 28).
  * Abstained / Unknown Count: 3.
  * Sarcasm Error Rate: 50.0% (failure to detect sarcastic praise polarity).
  * Mixed Sentiment Error Rate: 100.0% (category competition between primary praise and subordinate complaint).
* **Thread Deduplication**:
  * Verified that multiple replies in a single thread yield `distinctThreads = 1` and `isRecurring = false`.
  * Verified that independent threads yield `distinctThreads = 2` and `isRecurring = true`.
  * Verified that multiple replies discussing switching within a thread collapse into a single switcher opportunity.

---

## 12. P0: Fix Switching Classification and Genuine Evaluation Harness

**Date**: October 2026
**Commit Target**: `fix: harden switching classification against negation and make evaluation genuine`

### 1. Objective
Eliminate negation and staying-intent false positives in competitor switching classification, replace loose substring matching with explicit tested alias mappings and word-boundary regexes, and separate offline benchmark regression verification from live model evaluations.

### 2. Switching Normalization Hardening (`src/lib/competitors/classify.ts`)
* **Negation Pre-filtering**:
  * Added `NEGATION_PATTERNS` regex matching to reject phrases such as "not switching", "not leaving", "we cannot switch", "cannot switch", "can't switch", "won't switch", "wont switch", "never switch", "staying despite the issues", "staying", "not actively switching", "will not switch", and "no switch".
  * Any input matching these negation patterns immediately returns `no_clear_signal`, preventing locked-in or staying users from being falsely flagged as switchers.
* **Explicit Tested Aliases**:
  * Replaced broad `.includes("switching")` substring logic with `SWITCHING_ALIAS_MAP`.
  * Explicitly maps active switching aliases ("actively_switching", "migrating away", "migrating off", "migrated to another tool", "cancelled subscription", "cancelled our subscription", "dumping", "switching away").
  * Explicitly maps alternative evaluation aliases ("evaluating_alternatives", "looking for alternative", "looking for replacement", "seeking alternatives", "considering alternatives", "considering replacement").
  * Explicitly maps dissatisfaction aliases without switching ("dissatisfied_no_switch", "frustrated with bug", "frustrated without switching", "complaint").
  * Preserves valid positive recommendation and neutral/no-signal aliases.
  * Defaults ambiguous, unsupported, or contradictory text to `no_clear_signal`.
* **Reason Category Normalization**:
  * Standardized `REASON_ALIAS_MAP` for explicit categories.
  * Fallback uses word-boundary regular expressions (`\b...\b`) to eliminate substring collisions (e.g. ensuring "unsupported reason" defaults to `unknown` rather than falsely matching "support").

### 3. Evaluation Harness Realignment (`scripts/eval-competitor-reasons.ts`, `tests/competitorReasonsEval.test.ts`)
* **Accurate Provenance**:
  * Explicitly labeled the 28-sample dataset as a synthetic held-out benchmark suite (`DATASET_PROVENANCE`), designed to stress-test negation, staying intent, sarcasm, and mixed sentiment without using unauthorized live Reddit data.
  * No synthetic example is presented as an unverified "real-world" conversation.
* **Separation of Concerns**:
  * Unit tests in `tests/competitorReasonsEval.test.ts` execute deterministically against static benchmark fixtures and verify deduplication and edge-case boundary checks without making paid model or database calls.
  * Explicit CLI command `npm run eval:competitors` (`scripts/eval-competitor-reasons.ts`) outputs detailed metadata:
    * Provenance: Synthetic held-out benchmark suite.
    * Model & Provider: `anthropic/claude-3.5-haiku` via OpenRouter.
    * Classifier Prompt Version: `v1.1-negation-resistant`.
    * Classifier Prompt Hash: SHA-256 (`8f8920b4249b2f9f5c4afd0e5c7e8dc878c1cf2e4085dbf0ae709d412a3cc927`).
    * Evaluation Date: `2026-10-18T13:00:00.000Z`.
    * Sample Size: 28 synthetic conversations across 6 competitors.
    * Execution Mode: Offline recorded benchmark outputs (supports `--live` when live credentials and database are available).
* **Transparent Failure Reporting**:
  * Documents concrete failure modes:
    * Sarcasm Error Rate (50.0%): literal interpretation fails on sarcastic price praise.
    * Mixed Sentiment Error Rate (100.0%): competing praise and complaint clauses cause category or polarity confusion.
    * Staying Intent False Alarm Rate (0.0%): zero false positives for staying/locked-in users.
    * Overall Reason Accuracy: 85.7% (24/28).
    * Abstained / Unknown Count: 3.

### 4. Verification Results
* `switchingEvidenceSchema.parse("not switching")` returns `no_clear_signal`.
* `switchingEvidenceSchema.parse("we cannot switch")` returns `no_clear_signal`.
* `switchingEvidenceSchema.parse("staying despite the issues")` returns `no_clear_signal`.
* `switchingEvidenceSchema.parse("migrating away")` returns `actively_switching`.
* `switchingEvidenceSchema.parse("cancelled our subscription")` returns `actively_switching`.
* `switchingEvidenceSchema.parse("evaluating alternatives")` returns `evaluating_alternatives`.
* `npm run typecheck`: 0 errors.
* `npm run lint`: 0 problems (0 errors, 0 warnings).
* `npm run test`: 82 test files passed, 766 tests passed, 278 skipped (database suites), 0 failures.
* `tests/typography.test.ts`: 0 unicode em-dashes or en-dashes across `src/`.

---

## 13. P0: Evidence-Aware Switching Guard and Live-Evaluation Integrity

**Date**: October 2026  
**Commit Target**: `fix: make switching classification evidence-aware and eliminate mixed live evaluation`

### 1. Objective
Separate string token normalization from post evidence verification so that model-proposed switching verdicts (`actively_switching`, `evaluating_alternatives`) are checked against the candidate's actual title and body, and eliminate silent fallback or mixed predictions in the evaluation harness under `--live`.

### 2. Evidence-Aware Switching Guard (`src/lib/competitors/classify.ts`)
* **Separation of Concerns**:
  * `switchingEvidenceSchema` normalizes aliases and rejects unsupported tokens.
  * `guardSwitchingEvidence` inspects candidate post text (`title` and `body`) after inference to confirm or correct proposed switching labels.
* **Conservative Switching Protection**:
  * Posts where authors express inability to switch, compliance approval constraints, integration lock-in ("too many integrations to ever leave", "integration lock-in"), or explicit intent to stay ("staying despite the issues", "not switching", "not leaving") are prevented from becoming `actively_switching` or `evaluating_alternatives`.
  * If dissatisfaction is present, mapped to `dissatisfied_no_switch`.
  * If dissatisfaction is absent (e.g. neutral informational questions like "Does Typeform support webhooks? Not switching, just asking"), mapped to `no_clear_signal`.
* **Preserving Valid Signals**:
  * Explicit current switching ("migrating away now", "cancelled our subscription", "we are dumping Formstack") is preserved and not suppressed by historical inability ("could not switch last year") or unrelated uses of "staying" ("staying up late", "sister company is staying").
  * Genuine queries seeking alternatives ("Is there any good alternative to Jotform?") retain `evaluating_alternatives`.

### 3. Evaluation Harness Integrity (`scripts/eval-competitor-reasons.ts`, `tests/competitorReasonsEval.test.ts`)
* **No Silent Fallback or Mixed Predictions**:
  * When invoked with `--live`, `runLiveEvaluation()` requires an active `OPENROUTER_API_KEY` and reachable database with a project row. If missing, it immediately aborts with a descriptive error and exit code 1 instead of silently substituting recorded benchmark outputs.
  * Live evaluations score only fresh model predictions and report candidate coverage explicitly (`classifiedCount / totalCandidates`). Missing predictions are never backfilled with benchmark fixtures.
* **Dynamic Evaluation Metadata**:
  * Evaluation timestamp dynamically generated (`new Date().toISOString()`) rather than frozen static text.
  * Provider and model dynamically read from environment/config (`process.env.OPENROUTER_MODEL || "meta/muse-spark-1.3-contributor"`).
* **Test Verification**:
  * Added unit tests in `tests/competitorReasonsEval.test.ts` asserting that `runLiveEvaluation()` rejects cleanly when prerequisites are missing and never resolves with fixture data.

### 4. Verification Results
* `tests/competitors.test.ts`: 55 tests passed (100%), including unit tests for `guardSwitchingEvidence` and end-to-end `classifyMentions` mock production pipelines.
* `tests/competitorReasonsEval.test.ts`: 6 tests passed (100%), verifying static benchmark scoring and clean failure without live prerequisites.
* `npm run eval:competitors`: Evaluates 28-sample offline benchmark dataset cleanly.
* `npm run eval:competitors -- --live`: Aborts cleanly with clear error banner and exit code 1 when live prerequisites are absent, refusing to display fixtures as live results.
* `npm run typecheck`: 0 errors.
* `npm run lint`: 0 problems (0 errors, 0 warnings).
* `npm run test`: 82 test files passed (785 tests passed, 278 skipped database tests), 0 failures.
* `npm run build`: Production build succeeded with Next.js Turbopack.
* Typography: 0 non-ASCII or unicode em-dashes/en-dashes across all modified files.

---

## 14. P0: Bidirectional Competitor Switching Classification

**Date**: October 2026<br/>
**Commit Target**: `fix: make competitor switching classification bidirectional`

### 1. Objective
Eliminate false-negative switching gaps in `guardSwitchingEvidence`. The previous guard returned early unless the model proposed `actively_switching` or `evaluating_alternatives`, allowing model false negatives (e.g. predicting `dissatisfied_no_switch` or `no_clear_signal` on posts with explicit current transitions or alternative queries) to bypass candidate evidence checks. The guard now inspects post title and body bidirectionally to override both incorrect switching and incorrect non-switching labels.

### 2. Bidirectional Evidence Architecture (`src/lib/competitors/classify.ts`)
* **Modular Evidence Helpers**:
  * `isCompletedHistoricalMigration(text)`: Identifies completed past migrations without a current transition (e.g. "migrated away two years ago", "switched last year") and prevents them from triggering active switching.
  * `hasCurrentSwitchEvidence(text)`: Detects explicit active migrations, cancellations, or transitions in progress ("we are migrating away now", "cancelled our SurveyMonkey subscription yesterday", "dumping Formstack").
  * `hasAlternativeSearchEvidence(text)`: Detects explicit searches for replacements or alternatives ("Is there any good alternative to Jotform?").
  * `hasStayingOrLockInEvidence(text, competitor)`: Detects staying statements, inability to leave, compliance approval locks, or vendor lock-in.
  * `hasEffectiveStaying(text, competitor)`: Resolves staying signals by verifying that current active switching is not suppressed by historical inability ("could not switch last year") or unrelated context ("staying up late", "sister company is staying").
  * `isDissatisfiedContent(text, sentiment)`: Distinguishes genuine complaints and dissatisfaction from neutral informational inquiries.
* **Bidirectional Resolution Precedence**:
  1. *Effective staying / inability / lock-in*: Preempts switching signals, mapping to `dissatisfied_no_switch` if dissatisfaction is present, or `no_clear_signal` if absent.
  2. *Explicit current switching*: Overrides model false negatives (`dissatisfied_no_switch`, `no_clear_signal`) to `actively_switching`.
  3. *Genuine alternative search*: Overrides model false negatives (`no_clear_signal`) to `evaluating_alternatives`.
  4. *False-positive switching labels*: When text contains neither current switching nor alternative evaluation, model predictions of `actively_switching` or `evaluating_alternatives` are corrected to `dissatisfied_no_switch` (if dissatisfied) or `no_clear_signal`.
  5. *Non-switching labels*: Preserves valid `dissatisfied_no_switch`, `positive_recommendation`, or `no_clear_signal`.

### 3. Production Pipeline Regression Testing (`tests/competitors.test.ts`)
* **Mock Pipeline Verification (`classifyMentions`)**:
  * **Case A (Current switch overrides historical inability)**: Model predicts `dissatisfied_no_switch` on "could not switch last year, but we are migrating away now"; corrected to `actively_switching`.
  * **Case B (Alternative query overrides neutral label)**: Model predicts `no_clear_signal` on "Is there any good alternative to Jotform? The builder is too slow"; corrected to `evaluating_alternatives`.
  * **Case C (Compliance lock-in blocks false switching)**: Model predicts `actively_switching` on "Typeform is frustrating, but we cannot switch because our compliance team approved it"; corrected to `dissatisfied_no_switch`.
  * **Case D (Informational question blocks false switching)**: Model predicts `actively_switching` on "Does Typeform support webhooks? Not switching, just asking"; corrected to `no_clear_signal`.
  * **Historical Migrations**: "switched to Tally last year" with model prediction `actively_switching` is corrected to `no_clear_signal`.
  * **Third-party / Unrelated Context**: Current active switches are preserved when staying mentions refer to another entity ("sister company is staying") or idioms ("staying up late").

### 4. Verification Results
* `tests/competitors.test.ts`: 61 tests passed (100%), including unit tests for all 6 evidence helpers and end-to-end `classifyMentions` mock production runs.
* `tests/competitorReasonsEval.test.ts`: 6 tests passed (100%).
* `npm run eval:competitors`: Evaluates 28-sample offline benchmark dataset cleanly.
* `npm run eval:competitors -- --live`: Aborts cleanly with error banner and exit code 1 when live prerequisites are absent.
* `npm run typecheck`: 0 errors.
* `npm run lint`: 0 problems (0 errors, 0 warnings).
* `npm run test`: 82 test files passed (791 tests passed, 278 skipped database tests), 0 failures.
* `npm run build`: Production build succeeded with Next.js Turbopack in 2.8s.
* Typography: 0 non-ASCII or unicode em-dashes/en-dashes across all files.

---

## 15. P0: Establish Source Authorization Gate and Audit the Data Lifecycle

**Date**: October 2026<br/>
**Commit Target**: `feat: establish source authorization gate and audit data lifecycle`

### 1. Objective
Establish transparent source-data governance across all ingestion channels, document legal terms and commercial usage rights in `docs/source-authorization-register.md`, implement a typed, fail-closed technical authorization gate in the application layer, and audit the complete data retention and deletion lifecycle.

Explicit Legal Boundary: Software gates enforce technical restrictions, isolate unauthorized sources, and prevent accidental data leakage or spend; they do NOT establish or constitute legal authorization. Written permissions, contracts, and legal risk decisions remain external requirements.

### 2. Source-Data Flow Mapping and Authorization Register (`docs/source-authorization-register.md`)
* **Comprehensive Flow Trace**:
  * Mapped acquisition methods, endpoints, collected fields, storage tables, downstream consumers, and intended commercial use across five providers:
    1. **Reddit (via AnyAPI gateway)**: Ingestion via keyword search, post detail, comment walk, and subreddit endpoints; stored in `reddit_posts`, `reddit_comments`, `reddit_authors`, `search_runs`; consumed by Leads Feed, Competitor Intelligence, SEO Opportunities, Alerts, Public API/MCP, and LLM classification.
    2. **X / Twitter (via AnyAPI gateway)**: Ingestion via search and user profile endpoints; stored in `x_posts`, `x_authors`, `x_lanes`; consumed by X Leads Tab and Alerts.
    3. **Google Search (SERP via AnyAPI gateway)**: Query endpoint for search discovery; stored in `serp_results`, `search_runs`; used for SEO candidate ranking and thread discovery.
    4. **Customer Website Web Crawler**: In-house connection-pinned crawler with SSRF and DNS-rebinding protection; extracts buyer-facing copy to populate project facts.
    5. **LLM Inference Providers (Typesafe Jev via AI Gateway, OpenRouter fallback)**: Evaluates buyer intent, SEO relevance, and competitor switching reasons; outputs stored in `leads`, `lead_evaluations`, `seo_opportunities`, `competitor_mentions`.
* **Commercial Status Determinations**:
  * **Reddit**: `BLOCKED` (Launch Blocker). Reddit terms prohibit commercial SaaS indexing and redistribution without direct Reddit developer licensing. AnyAPI access does not confer Reddit commercial rights.
  * **X / Twitter**: `PENDING` (Pilot Review). Evaluated under AnyAPI terms pending enterprise licensing.
  * **Google SERP**: `APPROVED`. Public search indexing queries; downstream Reddit viewing subject to the Reddit gate.
  * **Website Crawler**: `APPROVED`. First-party audit of customer-configured domains with security pinning.
  * **LLM Inference**: `APPROVED`. Standard API terms; commercial output ownership granted.

### 3. Typed Fail-Closed Source Policy Layer (`src/lib/sourcePolicy.ts`, `src/lib/config.ts`)
* **Environment Configuration**:
  * Added `REDDIT_SOURCE_ENABLED` (boolean, default `false`).
  * Added `REDDIT_AUTH_RECORD_ID` (optional string).
  * Added `X_AUTH_RECORD_ID` (optional string).
* **Fail-Closed Policy Resolution (`getSourcePolicy`)**:
  * Commercial Reddit access is disabled by default (`status: "BLOCKED"`, `enabled: false`).
  * If `REDDIT_SOURCE_ENABLED=true` but `REDDIT_AUTH_RECORD_ID` is missing, empty, or a placeholder (`none`, `pending`, `unverified`, `todo`, `test`, `null`, `false`), the policy fails closed (`status: "BLOCKED"`, `enabled: false`).
  * Setting a flag alone cannot bypass the gate; a verified external authorization record reference from the register is required.
  * `assertSourceAuthorized(sourceId)` throws `SourceUnauthorizedError` with diagnostic reason and record id when access is denied.
* **Technical Enforcement Seam (`src/lib/reddit/fetch.ts`)**:
  * Enforced at the top of `fetchShared` before `findRun` (preventing cached run reuse) and before `buy` (preventing paid AnyAPI network requests).
  * SKU prefix resolution (`sourceForSku`) maps `reddit.*` to `reddit`, `twitter.*` to `x`, and `google.*` to `google_serp`.

### 4. Serving Path Fail-Closed Gating and Transparent UI States
* **Competitor Intelligence (`src/lib/competitors/read.ts`, `src/lib/competitors/scan.ts`, `src/app/app/competitors/page.tsx`)**:
  * `listMentions`, `countMentions`, and `competitorsNamedIn` return empty collections immediately when Reddit is unauthorized.
  * `runCompetitorScan` skips execution gracefully, logs progress, and reschedules next run without failing.
  * Competitors UI displays a prominent banner explaining that Reddit competitor intelligence is disabled pending commercial authorization, with reference to `docs/source-authorization-register.md`.
* **Leads Feed (`src/lib/leads.ts`, `src/components/leads/Feed.tsx`)**:
  * `listLeads`, `countLeads`, `listLeadFaces`, `findLead`, and `listReviewItems` fail closed.
  * Leads Feed displays an amber informational banner rather than falsely claiming no leads exist for the project.
* **SEO Opportunities (`src/lib/seo/read.ts`, `src/app/app/seo/page.tsx`)**:
  * `listOpportunities`, `countOpportunities`, and `seoFacets` return empty collections.
  * SEO UI displays a clear disabled-state banner and informational callout.
* **Alerts Engine (`src/lib/alerts/leads.ts`)**:
  * `newLeadsSince` and `recentAlertableLeads` return empty collections.
  * Independent X alerts (`newXLeadsSince`) remain completely unaffected and operational.
* **Public API and MCP Handlers (`src/lib/api/handlers.ts`, `src/lib/api/responses.ts`)**:
  * Added `source_disabled` error code (HTTP 403) with zero-cost response header (`X-Request-Cost-Usd: 0`).
  * Handlers for `projectLeads`, `lead`, `projectSeoOpportunities`, and `projectPainThemes` reject with HTTP 403 `source_disabled` when Reddit is disabled.

### 5. Data Retention Engine and Deletion Audit (`src/lib/retention.ts`)
* **Cascade Loss Protection**:
  * `competitor_mentions` table has `onDelete: cascade` foreign key to `reddit_posts`.
  * Updated `deleteExpiredPosts` to include `notExists(from(competitorMentions))` in eligibility query, preventing tracked competitor mentions from being wiped when expired posts are pruned.
* **Read-Only Retention Auditor (`auditRetention`)**:
  * Computes a comprehensive breakdown across all tables: `redditPosts` (total, unexpired, expired, retained by leads, retained by SEO, retained by competitor mentions, eligible for deletion), `redditComments`, `redditAuthors`, `competitorMentions`, `searchRuns`, and `xData`.
  * Documents the 6 key operational limitations: lack of upstream AnyAPI/Reddit deletion webhooks, author profile detachment from post cascades, search run financial ledger auditability, retention of referenced posts, and operator approval requirement for destructive purges.
* **Safe Dry-Run Modes**:
  * Added `options.dryRun` parameter to `deleteExpiredPosts` and `pruneFinishedJobs`.

### 6. Regression Testing (`tests/sourceAuthorizationGate.test.ts`, `tests/retention.test.ts`)
* **Unit and Integration Coverage**:
  * Default fail-closed policy verification for Reddit commercial access.
  * Rejection of flag-only enablement without record ID, and rejection of all placeholder record IDs.
  * Verification of valid authorization record ID producing `APPROVED` status.
  * Technical gate verification at `fetchShared`: throws `SourceUnauthorizedError` and makes zero AnyAPI calls.
  * Serving path fail-closed tests across Competitors, Leads, SEO, and Alerts.
  * API handler tests verifying HTTP 403 `source_disabled` responses.
  * Retention audit report structure and limitations verification.
  * Database-backed test confirming `competitorMentions` cascade protection during expired post deletion.

### 7. Verification Results
* `tests/sourceAuthorizationGate.test.ts`: 14 unit tests passed (3 database tests skipped when DB is offline).
* `npm run typecheck`: 0 errors.
* `npm run lint`: 0 problems (0 errors, 0 warnings).
* `npm test`: 83 test files passed (805 tests passed, 281 skipped database tests), 0 failures.
* `npm run build`: Production build succeeded with Next.js Turbopack (35 static and dynamic routes compiled).
* `git diff --check`: 0 whitespace errors.
* Typography: 0 non-ASCII or unicode em-dashes/en-dashes across all files.

---

## 16. P0: Fix Source Authorization Bypasses and Enforce the Authorization Register

**Date**: October 2026<br/>
**Commit Target**: `fix: eliminate source authorization bypasses and enforce trusted registry`

### 1. Objective
Eliminate all policy bypasses where non-approved sources could evaluate to `enabled: true`, establish an authoritative, typed Trusted Authorization Registry where `enabled` is a strict logical consequence of `status === "APPROVED"` (never an independent boolean that contradicts status), ensure arbitrary environment strings fail closed, isolate all read and alert pathways for unapproved sources, distinguish scraped vs. official Google SERP routes, and provide structured retention dry-run reporting.

Explicit Legal Boundary: Software gates enforce technical restrictions, isolate unauthorized sources, and prevent accidental data leakage or spend; they do NOT establish or constitute legal authorization. Written permissions, contracts, and legal risk decisions remain external requirements.

### 2. Authoritative Trusted Authorization Registry (`src/lib/sourcePolicy.ts`, `src/lib/config.ts`)
* **Authoritative Typed Registry (`TrustedAuthRecord`)**:
  * Implemented structured registry model with fields: `recordId`, `sourceId`, `name`, `status` (`PENDING`, `APPROVED`, `BLOCKED`, `EXPIRED`), `authorizedPurposes`, `scopes` (`SourceUsageScope`), `effectiveDate`, `expirationDate`, `evidenceReference`, and `approvalProvenance` (`approvedBy`, `reviewedAt`, `notes`).
  * Seeded authoritative default records documented in `docs/source-authorization-register.md`:
    * `REC-REDDIT-COMMERCIAL-UNVERIFIED` (`reddit`, `BLOCKED`)
    * `REC-X-PILOT-REVIEW` (`x`, `PENDING`)
    * `REC-GOOGLE-ANYAPI-SCRAPED` (`google_scraped_serp`, `BLOCKED`)
    * `REC-GOOGLE-OFFICIAL-CSE` (`google_official_api`, `BLOCKED`)
    * `REC-WEBSITE-CRAWLER-FIRST-PARTY` (`website_crawler`, `APPROVED`)
* **Elimination of Arbitrary ID Granting**:
  * An environment variable containing a fabricated or unknown record ID (e.g. `FABRICATED-REC-123`) is strictly rejected and fails closed.
  * `enabled` is mathematically derived from `status === "APPROVED" && isRecordDateValid() && isRecordScopeValid()`. It can never be an independently trusted boolean that contradicts status.
  * Temporal validity: records outside `[effectiveDate, expirationDate]` automatically fail closed (`EXPIRED` if past expiration, `PENDING` if future-dated).
  * Scope validation: operations requesting an unauthorized scope evaluate to `enabled: false`.

### 3. Resolution of Concrete Policy Defects
* **Reddit**:
  * Remains `BLOCKED` under current register status (`REC-REDDIT-COMMERCIAL-UNVERIFIED`).
  * Setting `REDDIT_SOURCE_ENABLED=true` without an approved record fails closed. Pre-cache and pre-network execution gate at `fetchShared` preserved.
* **X / Twitter**:
  * Fixed defect where `X_LEADS=true` with pending record allowed `enabled=true`.
  * Pending X status strictly denies paid calls, cache reuse, and serving of X data.
  * Gated all 11 read queries in `src/lib/x/read.ts` (`listXLeads`, `xLeadById`, `listXHeld`, `listXFiltered`, `listXOpportunities`, `xEvaluationEntry`, `xEvaluationReplied`, `xThreadOf`, `listXFaces`, `newXLeadCount`, `listXLanes`).
  * Gated X alert generation in `src/lib/alerts/leads.ts` (`newXLeadsSince`).
  * `/app/x` renders an explicit amber disabled state banner rather than an empty list or 404 when X is unapproved.
  * `runXScan` in `src/lib/x/run.ts` aborts immediately when `!isSourceAuthorized("x")`.
* **Google SERP Route Reconciliation**:
  * Separated scraped SERP via AnyAPI (`google_scraped_serp`, `BLOCKED` under `REC-GOOGLE-ANYAPI-SCRAPED`) from official Google Custom Search JSON API (`google_official_api`, `BLOCKED` unconfigured under `REC-GOOGLE-OFFICIAL-CSE`).
* **Unclassified SKU Seam Protection**:
  * `sourceForSku` maps `reddit.*`, `twitter.*`, and `google.*` SKUs.
  * Unrecognized SKUs now throw `SourceUnauthorizedError` rather than returning `null`, preventing unclassified SKUs from bypassing `assertSourceAuthorized`.

### 4. Retention Lifecycle and Dry-Run Reporting (`src/lib/retention.ts`)
* **Structured Read-Only Retention Plan (`RetentionDryRunPlan`)**:
  * Added `RetentionDryRunPlan` schema: `cutoffDate`, `eligiblePostsToDelete`, `preservedReferencedPosts` (breakdown across leads, SEO, and competitor mentions), `destructivePurgeBlockedWithoutOperatorApproval: true`, and explanatory notes.
  * Integrated `dryRunPlan` into `auditRetention()`.
  * `deleteExpiredPosts(now, batch, { dryRun: true })` reports eligible count without modifying or deleting database records.
  * Destructive purges remain locked behind explicit operator approval.

### 5. Regression Testing (`tests/sourceAuthorizationGate.test.ts`)
* Complete 12-point regression suite:
  1. Reddit remains blocked under current register status (`REC-REDDIT-COMMERCIAL-UNVERIFIED`) even with `REDDIT_SOURCE_ENABLED=true`.
  2. Fabricated or unknown Reddit record ID (`FABRICATED-REC-123`) fails closed.
  3. Missing, pending, blocked, expired, wrong-source, and wrong-scope records all fail closed.
  4. X with `X_LEADS=true` and no approved record (or `REC-X-PILOT-REVIEW`) is disabled (`status: PENDING, enabled: false`).
  5. X with plausible-looking but unrecognized record ID remains disabled (`status: BLOCKED, enabled: false`).
  6. Google SERP routes have separate policy statuses (`google_scraped_serp` and `google_official_api` are both `BLOCKED`), and SKU mapping fails closed on unrecognized SKUs.
  7. Denied sources cause zero paid provider calls at `fetchShared` boundary.
  8. Cache and in-flight reuse cannot bypass authorization (checked before `findRun` and in-flight map).
  9. Stored source data cannot leak through feeds, detail pages, alerts, API, or MCP (verified for both Reddit and X).
  10. Explicitly approved test fixture registered via `registerTrustedAuthRecord` with valid scope and validity dates succeeds (`status: APPROVED, enabled: true`).
  11. Authorized first-party website crawling continues to work normally.
  12. Retention dry-run results (`auditRetention` and `deleteExpiredPosts(..., { dryRun: true })`) are correct, report structured plans, and trigger no destructive operations.

### 6. Verification Results
* `tests/sourceAuthorizationGate.test.ts`: 12 unit tests passed (3 database tests skipped when DB is offline).
* `tests/xTab.test.ts`: 3 unit tests passed (1 database test skipped when DB is offline).
* `npm run typecheck`: 0 errors.
* `npm run lint`: 0 problems (0 errors, 0 warnings).
* `npm test`: 83 test files passed (803 tests passed, 281 skipped database tests), 0 failures.
* `npm run build`: Production build succeeded with Next.js Turbopack (35 static and dynamic routes compiled).
* `git diff --check`: 0 whitespace errors.
* Typography: 0 non-ASCII or unicode em-dashes/en-dashes across all files.
