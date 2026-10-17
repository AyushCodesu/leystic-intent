/**
 * Conservative evidence rules and sample thresholds for Leystic learning.
 * Centralized constants ensuring testability and consistent rule application.
 */

/** Minimum number of explicitly labelled leads before project-level learned prioritization is considered. */
export const MIN_PROJECT_LABELLED_LEADS = 5;

/** Minimum terminal outcomes (qualified progress + not_fit) before learned prioritization activates. */
export const MIN_PROJECT_TERMINAL_OUTCOMES = 5;

/** Minimum terminal outcomes for a category-level pattern to be classified as a directional signal. */
export const MIN_PATTERN_TERMINAL_OUTCOMES = 4;

/** Minimum qualified-progress outcomes needed to qualify a pattern as promising (must also exceed not_fit). */
export const MIN_PROMISING_QUALIFIED_OUTCOMES = 2;

/** Minimum not_fit outcomes needed to qualify a pattern as repeated mismatch (must also have zero qualified progress). */
export const MIN_REPEATED_MISMATCH_OUTCOMES = 3;

/** Deterministic query bound for learning analysis. */
export const OUTCOME_SAMPLE_LIMIT = 500;
