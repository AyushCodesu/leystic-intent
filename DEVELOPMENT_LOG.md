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

### 3. Held-Out Real-World Classification Evaluation
* Created reproducible evaluation dataset and harness (`scripts/eval-competitor-reasons.ts`, `tests/competitorReasonsEval.test.ts`) across 28 real-world conversations and 6 competitors (Typeform, Jotform, Tally, Fillout, SurveyMonkey, Formstack).
* Manually labeled independently of model outputs, explicitly including sarcasm, mixed sentiment, resolved complaints, and negative comments from users who explicitly intend to stay.
* **Evaluation Results**:
  * Sample Size: 28 conversations.
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
