/**
 * Outcome semantics for Leystic learning.
 * Pure, testable functions classifying user-confirmed lead outcomes into explicit commercial stages.
 */

import type { LeadOutcome } from "@/lib/feed";
import type { OutcomeCategory, QualifiedProgressKind } from "./types";

export const QUALIFIED_PROGRESS_OUTCOMES: readonly QualifiedProgressKind[] = [
  "meeting_booked",
  "opportunity",
  "customer",
] as const;

export const ENGAGEMENT_OUTCOMES: readonly LeadOutcome[] = ["replied"] as const;

export const MISMATCH_OUTCOMES: readonly LeadOutcome[] = ["not_fit"] as const;

/**
 * Categorizes a persisted outcome string into its official learning semantic category.
 * Invalid, unknown, or null outcomes are treated as unlabelled (never failures).
 */
export function categorizeOutcome(outcome: string | null | undefined): OutcomeCategory {
  if (!outcome) {
    return "unlabelled";
  }
  switch (outcome) {
    case "meeting_booked":
    case "opportunity":
    case "customer":
      return "qualified_progress";
    case "replied":
      return "engagement";
    case "not_fit":
      return "explicit_mismatch";
    default:
      return "unlabelled";
  }
}

/** Returns true if the outcome represents qualified commercial progress. */
export function isQualifiedProgress(outcome: string | null | undefined): outcome is QualifiedProgressKind {
  return categorizeOutcome(outcome) === "qualified_progress";
}

/** Returns true if the outcome represents founder engagement (reply) without commercial qualification. */
export function isEngagement(outcome: string | null | undefined): boolean {
  return categorizeOutcome(outcome) === "engagement";
}

/** Returns true if the outcome represents an explicit mismatch (not a fit). */
export function isExplicitMismatch(outcome: string | null | undefined): boolean {
  return categorizeOutcome(outcome) === "explicit_mismatch";
}

/**
 * Returns true if the outcome is terminal: qualified progress or explicit mismatch.
 * Replies (engagement) and unlabelled items are not terminal outcomes.
 */
export function isTerminalOutcome(outcome: string | null | undefined): boolean {
  const cat = categorizeOutcome(outcome);
  return cat === "qualified_progress" || cat === "explicit_mismatch";
}

/**
 * Returns a human-readable display label for an outcome value.
 */
export function outcomeDisplayLabel(outcome: string | null | undefined): string {
  if (!outcome) return "Unlabelled";
  switch (outcome) {
    case "meeting_booked":
      return "Meeting booked";
    case "opportunity":
      return "Opportunity";
    case "customer":
      return "Customer";
    case "replied":
      return "Replied";
    case "not_fit":
      return "Not a fit";
    default:
      return outcome;
  }
}
