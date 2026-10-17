# Leystic Demand-to-Page Gap Finder V1

## 1. Purpose and Scope

Leystic Demand-to-Page Gap Finder V1 connects public buyer demand discovered across Reddit conversations to the founder's own website pages.

By observing what prospective buyers repeatedly ask for, which conversations yield qualified commercial progress, and what content currently exists on the founder's website, Leystic identifies concrete demand-to-page coverage gaps.

This feature does NOT attempt to replace general-purpose SEO platforms (such as Ahrefs, Semrush, or OpenSEO), nor does it fabricate Google search volumes, search rankings, or keyword difficulty scores. Instead, it surfaces direct, evidence-backed opportunities:

```text
Persisted public buyer conversations
                |
                v
Deterministic demand signals
                |
                v
Existing website page inventory
                |
                v
Candidate demand-to-page matches
                |
                v
Founder confirmation
                |
                v
Evidence-backed demand gaps
                |
                v
Existing lead outcomes inform prioritization
```

---

## 2. Evidence Boundaries and Definitions

To ensure honesty and avoid fabricated SEO claims, the system strictly separates four distinct layers of information:

* **Observed demand**: Concrete facts from persisted lead records and their verified source URLs (e.g., Reddit thread and comment permalinks).
* **Observed website coverage**: Pages successfully inspected on the founder's website, including titles, descriptions, canonical URLs, H1s, and headings.
* **Founder-confirmed mapping**: Explicit founder confirmation that a website page addresses a discovered need, only partially addresses it, or that no inspected page addresses it.
* **Interpretation**: Evidence-bounded explanations of why an apparent gap may deserve attention (e.g., "Several relevant conversations were found, but we did not find a clearly matching page among the 15 pages inspected"). Never makes unverified assertions like "Buyers cannot find your product on Google."

---

## 3. Safe Website Page Inventory & Network Security

Website crawling represents an untrusted network boundary. Leystic enforces conservative, centralized security bounds:

* **SSRF Protection (`src/lib/gaps/security.ts`)**:
  * Protocol restricted to `http:` and `https:`.
  * Blocks `localhost`, `.local`, `.internal`, `.lan`, `0.0.0.0`, and all private/reserved IPv4 ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` AWS metadata, carrier-grade NAT, test nets, multicast, reserved).
  * Blocks IPv6 loopback (`::1`), unique local (`fc00::/7`), link-local (`fe80::/10`), and IPv4-mapped addresses.
  * Real-time DNS resolution checks to ensure destinations do not resolve to internal network resources.
  * Re-validates every redirect hop manually (`maxRedirects = 3`), ensuring redirects cannot escape the permitted project host or pivot to internal endpoints.
* **Crawl Bounds (`src/lib/gaps/constants.ts`)**:
  * `MAX_DISCOVERED_URLS = 50`: discovery queue ceiling.
  * `MAX_FETCHED_PAGES = 25`: maximum pages crawled per manual inspection request.
  * `FETCH_TIMEOUT_MS = 6000`: strict per-page timeout via `AbortSignal.timeout()`.
  * `MAX_RESPONSE_BYTES = 512 * 1024` (512 KB): stream-level response byte cap.
  * `MAX_SITEMAP_BYTES = 1024 * 1024` (1 MB): sitemap XML limit.
* **Robots.txt & Sitemap Discovery**:
  * Respects `robots.txt` disallow rules for `User-agent: *`.
  * Inspects `sitemap.xml` and sitemaps declared in `robots.txt`.
  * Falls back to homepage crawling and internal link traversal when sitemaps are absent.
  * Canonical URL deduplication prevents redundant crawling.
* **Explicit User Initiation**:
  * No crawling occurs during page load, render, or background refresh.
  * Inspections are triggered solely by explicit founder action ("Inspect website coverage").

---

## 4. Deterministic Demand Analysis & Outcome Integration

* **Tenant Isolation**: Only leads where `leads.projectId = projectId` are examined (`LIMIT 250`).
* **Thread Deduplication**: Multiple lead records sharing the same underlying `postId` are consolidated so that a single lively conversation cannot artificially inflate demand counts.
* **Outcome Semantics (Reusing Learning V1)**:
  * `meeting_booked`, `opportunity`, `customer`: qualified commercial progress.
  * `replied`: founder engagement.
  * `not_fit`: explicit mismatch.
  * Null / missing: unlabelled (never treated as failure).
* **Deterministic Topic Normalization**:
  * Strips conversational boilerplate ("looking for", "alternative to", "best", "recommend me", "anyone using").
  * Extracts normalized tokens and 2-grams with stop-word filtering.
  * Preserves verified links and excerpts for every supporting conversation.
  * Flags single unlabelled threads as `weaklySupported = true` for founder review.

---

## 5. Demand-to-Page Matching Engine

Located in `src/lib/gaps/matching.ts`:
* Evaluates demand topics and terms against page metadata:
  * Page `title` (weight 4)
  * Page `h1` (weight 4)
  * Page `path` (weight 3)
  * Page `headings` (weight 2)
  * Page `description` (weight 1)
* Incorporates rule-based suffix stemming (`-ies`, `-es`, `-s`) to match singular/plural forms ("survey" vs. "surveys", "form" vs. "forms").
* Categorizes page coverage into:
  * `matched`: score >= 6 (exact phrase or strong keyword match).
  * `possible_match`: score >= 2 and < 6 (partial keyword overlap).
  * `no_match_found`: score < 2 when pages were successfully inspected.
  * `insufficient_evidence`: website has not been inspected or inspection failed.

---

## 6. Prioritization Rules & Scoped Explanations

Located in `src/lib/gaps/prioritization.ts`:
* **High Priority Gap**: Requires BOTH an unaddressed coverage status (`no_match_found` or founder `confirmed_gap`) AND empirical significance ($\ge 2$ distinct buyer threads OR $\ge 1$ qualified commercial progress outcome). A gap is never marked high priority merely because a page is missing.
* **Medium Priority Gap**: Single unlabelled conversation with `no_match_found`, or multiple conversations with `possible_match`.
* **Developing Evidence**: Weakly supported single conversations or uninspected sites.
* **Covered / Addressed**: Confirmed match by founder or strong automated match.
* **Three-Part Scoped Breakdown**:
  * **1. What we observed**: Exact counts of distinct threads, subreddits, and outcome breakdown with clickable links to verified Reddit posts.
  * **2. Why it may matter**: Bounded explanation of why prospective buyers might not find a matching page on the site.
  * **3. What needs confirmation**: Transparent status and founder review controls.

---

## 7. Founder Confirmation Workflow

* Allows founders to review and refine automated suggestions without altering underlying lead records or historical outcomes:
  * **Confirm match**: Confirms that a suggested page addresses the buyer demand.
  * **Mark partial**: Flags that the suggested page only partially answers the demand.
  * **Confirm gap**: Confirms that no inspected page addresses the demand.
  * **Reset**: Returns mapping to unconfirmed.
* Enforces server-side authorization via `requireOwnedProject(projectId)`.
* Persisted in `demand_page_confirmations` with unique index on `(projectId, demandGroupId)`.

---

## 8. Persistence & Failure Handling

* Schema additions in `drizzle/0041_demand_page_gaps.sql`:
  * `website_inspections`: tracks inspection runs (`success`, `partial`, `failed`), counts, and errors.
  * `website_pages`: stores inspected page metadata linked to `inspectionId`.
  * `demand_page_confirmations`: stores founder confirmation overrides.
* **Snapshot Preservation Guarantee**:
  * If a subsequent website inspection attempt fails (e.g. host unreachable, DNS timeout), the previous successful inspection snapshot and its indexed pages are fully preserved.
  * The UI renders a non-blocking warning banner about the failure while continuing to display the candidate gaps from the preserved snapshot.

---

## 9. Verification Summary

* **Static Typing & Quality**:
  * `npm run typecheck`: 0 errors.
  * `npm run lint`: 0 errors, 0 warnings.
  * `npm run build`: successful production build.
  * `git diff --check`: 0 whitespace issues.
  * `tests/typography.test.ts`: verified no unicode em-dashes or en-dashes in `src/`.
* **Test Suite**:
  * 81 test files passed (732 tests passed, 31 database-backed suites skipped when PostgreSQL is offline, 0 failures).
  * 7 new gap finder test suites:
    * `tests/gapsSecurity.test.ts` (13 tests)
    * `tests/gapsHtml.test.ts` (4 tests)
    * `tests/gapsCrawler.test.ts` (3 tests)
    * `tests/gapsDemand.test.ts` (4 tests)
    * `tests/gapsMatching.test.ts` (4 tests)
    * `tests/gapsPrioritization.test.ts` (3 tests)
    * `tests/gapsUI.test.ts` (3 tests)
    * `tests/gapsStore.test.ts` (1 database test)

---

## 10. Future Possibilities (Explicitly Deferred)

The following extensions are documented for potential future iterations and are NOT part of V1:
* **Google Search Console Integration**: Connecting Search Console OAuth to cross-reference discovered buyer demand against actual impressions, queries, and clicks.
* **Sitemap Auto-Sync**: Scheduled re-crawling with change detection.
* **Keyword SERP Expansion**: Live rank tracking of competitor pages on discovered intent phrases.
