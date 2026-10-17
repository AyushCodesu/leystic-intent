import { describe, expect, it } from "vitest";
import {
  categorizeOutcome,
  isEngagement,
  isExplicitMismatch,
  isQualifiedProgress,
  isTerminalOutcome,
  outcomeDisplayLabel,
  QUALIFIED_PROGRESS_OUTCOMES,
  ENGAGEMENT_OUTCOMES,
  MISMATCH_OUTCOMES,
} from "@/lib/learning/semantics";

describe("Outcome semantics & classification", () => {
  it("treats meeting_booked, opportunity, and customer as qualified progress", () => {
    expect(categorizeOutcome("meeting_booked")).toBe("qualified_progress");
    expect(categorizeOutcome("opportunity")).toBe("qualified_progress");
    expect(categorizeOutcome("customer")).toBe("qualified_progress");

    expect(isQualifiedProgress("meeting_booked")).toBe(true);
    expect(isQualifiedProgress("opportunity")).toBe(true);
    expect(isQualifiedProgress("customer")).toBe(true);

    expect(isTerminalOutcome("meeting_booked")).toBe(true);
    expect(isTerminalOutcome("opportunity")).toBe(true);
    expect(isTerminalOutcome("customer")).toBe(true);

    // Each must remain separately identifiable
    expect(QUALIFIED_PROGRESS_OUTCOMES).toContain("meeting_booked");
    expect(QUALIFIED_PROGRESS_OUTCOMES).toContain("opportunity");
    expect(QUALIFIED_PROGRESS_OUTCOMES).toContain("customer");
    expect(new Set(QUALIFIED_PROGRESS_OUTCOMES).size).toBe(3);
  });

  it("treats replied as engagement and not as a qualified outcome or terminal outcome", () => {
    expect(categorizeOutcome("replied")).toBe("engagement");
    expect(isEngagement("replied")).toBe(true);
    expect(isQualifiedProgress("replied")).toBe(false);
    expect(isExplicitMismatch("replied")).toBe(false);
    expect(isTerminalOutcome("replied")).toBe(false);

    expect(ENGAGEMENT_OUTCOMES).toContain("replied");
  });

  it("treats not_fit as explicit mismatch and a terminal outcome", () => {
    expect(categorizeOutcome("not_fit")).toBe("explicit_mismatch");
    expect(isExplicitMismatch("not_fit")).toBe(true);
    expect(isQualifiedProgress("not_fit")).toBe(false);
    expect(isEngagement("not_fit")).toBe(false);
    expect(isTerminalOutcome("not_fit")).toBe(true);

    expect(MISMATCH_OUTCOMES).toContain("not_fit");
  });

  it("treats missing, null, undefined or unknown outcomes as unlabelled and never as failures", () => {
    expect(categorizeOutcome(null)).toBe("unlabelled");
    expect(categorizeOutcome(undefined)).toBe("unlabelled");
    expect(categorizeOutcome("")).toBe("unlabelled");
    expect(categorizeOutcome("unknown_status")).toBe("unlabelled");
    expect(categorizeOutcome("resolved")).toBe("unlabelled");
    expect(categorizeOutcome("hidden")).toBe("unlabelled");

    expect(isQualifiedProgress(null)).toBe(false);
    expect(isEngagement(null)).toBe(false);
    expect(isExplicitMismatch(null)).toBe(false);
    expect(isTerminalOutcome(null)).toBe(false);

    expect(isExplicitMismatch("unknown_junk")).toBe(false);
    expect(isTerminalOutcome("unknown_junk")).toBe(false);
  });

  it("provides human-readable labels without model jargon", () => {
    expect(outcomeDisplayLabel("meeting_booked")).toBe("Meeting booked");
    expect(outcomeDisplayLabel("opportunity")).toBe("Opportunity");
    expect(outcomeDisplayLabel("customer")).toBe("Customer");
    expect(outcomeDisplayLabel("replied")).toBe("Replied");
    expect(outcomeDisplayLabel("not_fit")).toBe("Not a fit");
    expect(outcomeDisplayLabel(null)).toBe("Unlabelled");
  });
});
