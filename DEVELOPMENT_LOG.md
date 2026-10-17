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
