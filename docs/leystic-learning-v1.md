# Leystic Learning V1: Make Lead Discovery Improve With Experience

## 1. Architectural Overview

Leystic Learning V1 establishes a deterministic, first-party learning layer derived directly from founder-confirmed lead outcomes.

```text
Found buyer-intent conversations
        ↓
Founder reviews and acts
        ↓
Founder records explicit outcomes
        ↓
Leystic identifies recurring outcome patterns
        ↓
Explainable learning insights (Insights tab)
        ↓
Optional outcome-informed lead prioritization (Leads view)
        ↓
Founder gets a more useful feed over time
```

## 2. Outcome Semantics

All outcomes are classified into pure domain semantics in `src/lib/learning/semantics.ts`:

* **Qualified progress**: `meeting_booked`, `opportunity`, `customer`. Progressive commercial evidence of value.
* **Engagement**: `replied`. Founder responded to the lead; not treated as a qualified commercial outcome.
* **Explicit mismatch**: `not_fit`. Founder indicated the lead was unsuitable.
* **Unlabelled / Unknown**: Missing, null, or unrecognized values contribute no positive or negative evidence (never treated as failures).

## 3. Conservative Evidence Rules & Thresholds

Centralized in `src/lib/learning/constants.ts`:

* `MIN_PROJECT_LABELLED_LEADS = 5`: Project must have at least 5 labelled leads.
* `MIN_PROJECT_TERMINAL_OUTCOMES = 5`: Project must have at least 5 terminal outcomes (`qualified_progress` + `not_fit`) before learned prioritization can activate.
* `MIN_PATTERN_TERMINAL_OUTCOMES = 4`: A dimension pattern needs at least 4 terminal outcomes before it can be classified as directional.
* `MIN_PROMISING_QUALIFIED_OUTCOMES = 2`: A pattern is `promising` only when it has at least 2 qualified-progress outcomes AND qualified progress strictly exceeds `not_fit`.
* `MIN_REPEATED_MISMATCH_OUTCOMES = 3`: A pattern is `repeated_mismatch` only when it has at least 3 `not_fit` outcomes AND 0 qualified-progress outcomes.
* `OUTCOME_SAMPLE_LIMIT = 500`: Deterministic query bound.

## 4. Prioritization Implementation

When the founder selects **Learned priority** in the feed:

1. Server checks if `enoughEvidenceToPrioritize` is true.
2. If true, `buildLearnedFeedOrder` constructs SQL ordering:
   * Tier 1: Leads matching promising patterns without mismatch patterns.
   * Tier 2: Neutral leads.
   * Tier 3: Leads matching repeated mismatch patterns without promising patterns.
   * Inside each tier, original `THREAD_BEST`, `THREAD_NEWEST`, and model scores (`leads.score`) are preserved as secondary order.
3. Pagination (`limit` and `offset`) is executed globally in Postgres before rendering.
4. If evidence is insufficient, feed automatically falls back to standard score order with a clear explanatory banner.

## 5. Security & Isolation

* Queries are strictly filtered by `leads.projectId = projectId`.
* User actions require `requireOwnedProject(projectId)`.
* Zero cross-tenant outcome pooling.
* Zero model or AnyAPI dependencies.
