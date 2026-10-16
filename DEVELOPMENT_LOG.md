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
