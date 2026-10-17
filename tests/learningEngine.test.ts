import { describe, expect, it } from "vitest";
import {
  assessLead,
  buildLearningSnapshot,
  evaluatePatternStatus,
} from "@/lib/learning/engine";
import {
  MIN_PATTERN_TERMINAL_OUTCOMES,
  MIN_PROJECT_LABELLED_LEADS,
  MIN_PROJECT_TERMINAL_OUTCOMES,
  MIN_PROMISING_QUALIFIED_OUTCOMES,
  MIN_REPEATED_MISMATCH_OUTCOMES,
} from "@/lib/learning/constants";
import type { LabelledLeadRecord } from "@/lib/learning/types";

describe("Learning Engine - Thresholds & Boundary Rules", () => {
  it("defines the exact centralized sample thresholds", () => {
    expect(MIN_PROJECT_LABELLED_LEADS).toBe(5);
    expect(MIN_PROJECT_TERMINAL_OUTCOMES).toBe(5);
    expect(MIN_PATTERN_TERMINAL_OUTCOMES).toBe(4);
    expect(MIN_PROMISING_QUALIFIED_OUTCOMES).toBe(2);
    expect(MIN_REPEATED_MISMATCH_OUTCOMES).toBe(3);
  });

  it("never classifies a single successful lead as a promising pattern", () => {
    // 1 qualified progress, 0 not fit -> terminal = 1 < 4
    expect(evaluatePatternStatus(1, 0)).toBe("insufficient_evidence");
  });

  it("never classifies a single not_fit lead as a repeated mismatch", () => {
    // 0 qualified progress, 1 not fit -> terminal = 1 < 4
    expect(evaluatePatternStatus(0, 1)).toBe("insufficient_evidence");
  });

  it("requires at least 4 terminal outcomes before directional classification", () => {
    // 2 qualified, 1 not fit -> terminal = 3 (< 4) -> insufficient_evidence
    expect(evaluatePatternStatus(2, 1)).toBe("insufficient_evidence");
    // 0 qualified, 3 not fit -> terminal = 3 (< 4) -> insufficient_evidence
    expect(evaluatePatternStatus(0, 3)).toBe("insufficient_evidence");
    // 3 qualified, 0 not fit -> terminal = 3 (< 4) -> insufficient_evidence
    expect(evaluatePatternStatus(3, 0)).toBe("insufficient_evidence");
  });

  it("verifies promising status exact boundaries", () => {
    // Exactly 4 terminal: 2 qualified, 1 not fit, wait 2+1=3 (insufficient)
    // 3 qualified, 1 not fit: terminal = 4 >= 4, qualified 3 >= 2, 3 > 1 -> promising
    expect(evaluatePatternStatus(3, 1)).toBe("promising");

    // 4 qualified, 0 not fit: terminal = 4 >= 4, qualified 4 >= 2, 4 > 0 -> promising
    expect(evaluatePatternStatus(4, 0)).toBe("promising");

    // 2 qualified, 2 not fit: terminal = 4, but qualified (2) is not > not fit (2) -> mixed
    expect(evaluatePatternStatus(2, 2)).toBe("mixed");

    // 1 qualified, 3 not fit: terminal = 4, qualified (1) is < 2 -> mixed
    expect(evaluatePatternStatus(1, 3)).toBe("mixed");
  });

  it("verifies repeated mismatch status exact boundaries", () => {
    // Exactly 4 terminal: 0 qualified, 4 not fit: terminal = 4 >= 4, not fit (4) >= 3, qualified === 0 -> repeated_mismatch
    expect(evaluatePatternStatus(0, 4)).toBe("repeated_mismatch");

    // 1 qualified, 4 not fit: qualified !== 0 -> mixed
    expect(evaluatePatternStatus(1, 4)).toBe("mixed");

    // 0 qualified, 3 not fit, terminal is 3 (< 4) -> insufficient_evidence
    expect(evaluatePatternStatus(0, 3)).toBe("insufficient_evidence");
  });

  it("conflicting patterns remain mixed rather than forced into promising or mismatch", () => {
    // 2 qualified, 2 not fit -> mixed
    expect(evaluatePatternStatus(2, 2)).toBe("mixed");
    // 3 qualified, 3 not fit -> mixed
    expect(evaluatePatternStatus(3, 3)).toBe("mixed");
    // 2 qualified, 3 not fit -> mixed
    expect(evaluatePatternStatus(2, 3)).toBe("mixed");
  });
});

describe("Learning Engine - Snapshot construction & deduplication", () => {
  const baseDate = new Date("2026-10-15T12:00:00Z");

  function makeRecord(
    id: string,
    outcome: string,
    subreddit = "SaaS",
    stage = "solution_seeking",
    projectId = "proj-1",
  ): LabelledLeadRecord {
    return {
      id,
      projectId,
      outcome,
      outcomeRecordedAt: baseDate,
      outcomeNotes: null,
      subreddit,
      stage,
      kind: "buyer",
    };
  }

  it("deduplicates records by lead ID so counts reflect unique leads", () => {
    const records: LabelledLeadRecord[] = [
      makeRecord("lead-1", "meeting_booked", "SaaS"),
      makeRecord("lead-1", "meeting_booked", "SaaS"), // duplicate
      makeRecord("lead-2", "customer", "SaaS"),
      makeRecord("lead-2", "customer", "SaaS"), // duplicate
      makeRecord("lead-3", "opportunity", "SaaS"),
      makeRecord("lead-4", "not_fit", "SaaS"),
    ];

    const snapshot = buildLearningSnapshot(records);
    expect(snapshot.labelledLeadCount).toBe(4);
    expect(snapshot.qualifiedProgressCount).toBe(3);
    expect(snapshot.notFitCount).toBe(1);
    expect(snapshot.terminalOutcomeCount).toBe(4);

    const saasPattern = snapshot.patterns.find(
      (p) => p.dimension === "community" && p.value === "saas",
    );
    expect(saasPattern).toBeDefined();
    expect(saasPattern?.qualifiedProgressCount).toBe(3);
    expect(saasPattern?.terminalOutcomeCount).toBe(4);
    expect(saasPattern?.supportingLeadIds).toEqual(["lead-1", "lead-2", "lead-3", "lead-4"]);
  });

  it("keeps different communities and intent stages strictly separate", () => {
    const records: LabelledLeadRecord[] = [
      makeRecord("l-1", "customer", "SaaS", "solution_seeking"),
      makeRecord("l-2", "customer", "SaaS", "solution_seeking"),
      makeRecord("l-3", "customer", "SaaS", "solution_seeking"),
      makeRecord("l-4", "not_fit", "SaaS", "solution_seeking"),
      makeRecord("l-5", "not_fit", "forhire", "problem_awareness"),
      makeRecord("l-6", "not_fit", "forhire", "problem_awareness"),
      makeRecord("l-7", "not_fit", "forhire", "problem_awareness"),
      makeRecord("l-8", "not_fit", "forhire", "problem_awareness"),
    ];

    const snapshot = buildLearningSnapshot(records);

    const saasPattern = snapshot.patterns.find(
      (p) => p.dimension === "community" && p.value === "saas",
    );
    const forhirePattern = snapshot.patterns.find(
      (p) => p.dimension === "community" && p.value === "forhire",
    );
    const solutionSeeking = snapshot.patterns.find(
      (p) => p.dimension === "stage" && p.value === "solution_seeking",
    );
    const problemAwareness = snapshot.patterns.find(
      (p) => p.dimension === "stage" && p.value === "problem_awareness",
    );

    expect(saasPattern?.status).toBe("promising");
    expect(saasPattern?.qualifiedProgressCount).toBe(3);
    expect(saasPattern?.notFitCount).toBe(1);

    expect(forhirePattern?.status).toBe("repeated_mismatch");
    expect(forhirePattern?.qualifiedProgressCount).toBe(0);
    expect(forhirePattern?.notFitCount).toBe(4);

    expect(solutionSeeking?.status).toBe("promising");
    expect(problemAwareness?.status).toBe("repeated_mismatch");
  });

  it("enforces project activation thresholds: requires 5+ labelled and 5+ terminal outcomes", () => {
    // 4 labelled leads: all terminal -> below 5 labelled leads
    const records4 = [
      makeRecord("l1", "customer"),
      makeRecord("l2", "meeting_booked"),
      makeRecord("l3", "opportunity"),
      makeRecord("l4", "not_fit"),
    ];
    const snap4 = buildLearningSnapshot(records4);
    expect(snap4.enoughEvidenceToPrioritize).toBe(false);

    // 5 labelled leads, but 2 are replied (engagement) -> 3 terminal < 5
    const records5WithReplies = [
      makeRecord("l1", "customer"),
      makeRecord("l2", "meeting_booked"),
      makeRecord("l3", "not_fit"),
      makeRecord("l4", "replied"),
      makeRecord("l5", "replied"),
    ];
    const snap5Replies = buildLearningSnapshot(records5WithReplies);
    expect(snap5Replies.labelledLeadCount).toBe(5);
    expect(snap5Replies.terminalOutcomeCount).toBe(3);
    expect(snap5Replies.enoughEvidenceToPrioritize).toBe(false);

    // 5 labelled leads, exactly 5 terminal outcomes -> activates
    const records5Terminal = [
      makeRecord("l1", "customer"),
      makeRecord("l2", "meeting_booked"),
      makeRecord("l3", "opportunity"),
      makeRecord("l4", "not_fit"),
      makeRecord("l5", "not_fit"),
    ];
    const snap5Terminal = buildLearningSnapshot(records5Terminal);
    expect(snap5Terminal.labelledLeadCount).toBe(5);
    expect(snap5Terminal.terminalOutcomeCount).toBe(5);
    expect(snap5Terminal.enoughEvidenceToPrioritize).toBe(true);
  });

  it("produces deterministic output independent of record input ordering", () => {
    const listA: LabelledLeadRecord[] = [
      makeRecord("l1", "customer", "SaaS"),
      makeRecord("l2", "customer", "SaaS"),
      makeRecord("l3", "customer", "SaaS"),
      makeRecord("l4", "not_fit", "SaaS"),
      makeRecord("l5", "not_fit", "marketing"),
      makeRecord("l6", "not_fit", "marketing"),
      makeRecord("l7", "not_fit", "marketing"),
      makeRecord("l8", "not_fit", "marketing"),
    ];

    const listB = [...listA].reverse();

    const snapA = buildLearningSnapshot(listA);
    const snapB = buildLearningSnapshot(listB);

    expect(snapA.patterns.map((p) => `${p.dimension}:${p.value}:${p.status}`)).toEqual(
      snapB.patterns.map((p) => `${p.dimension}:${p.value}:${p.status}`),
    );
  });

  it("assesses individual leads cleanly and explainably", () => {
    const records: LabelledLeadRecord[] = [
      makeRecord("l1", "customer", "SaaS", "solution_seeking"),
      makeRecord("l2", "customer", "SaaS", "solution_seeking"),
      makeRecord("l3", "customer", "SaaS", "solution_seeking"),
      makeRecord("l4", "not_fit", "SaaS", "solution_seeking"),
      makeRecord("l5", "not_fit", "forhire", "vendor_comparison"),
      makeRecord("l6", "not_fit", "forhire", "vendor_comparison"),
      makeRecord("l7", "not_fit", "forhire", "vendor_comparison"),
      makeRecord("l8", "not_fit", "forhire", "vendor_comparison"),
    ];
    const snapshot = buildLearningSnapshot(records);
    expect(snapshot.enoughEvidenceToPrioritize).toBe(true);

    // Lead matching promising community
    const goodLead = assessLead({ subreddit: "r/SaaS", stage: "other" }, snapshot);
    expect(goodLead.tier).toBe(1);
    expect(goodLead.explanation).toContain("Prioritized: r/saas has 3 qualified-progress outcomes");

    // Lead matching mismatch community
    const badLead = assessLead({ subreddit: "r/forhire", stage: "other" }, snapshot);
    expect(badLead.tier).toBe(3);
    expect(badLead.explanation).toContain("Deprioritized: r/forhire has 4 recorded not-a-fit outcomes");

    // Neutral lead
    const neutralLead = assessLead({ subreddit: "r/technology", stage: "other" }, snapshot);
    expect(neutralLead.tier).toBe(2);
    expect(neutralLead.explanation).toBeUndefined();

    // Mixed lead (promising stage but mismatch community)
    const mixedLead = assessLead({ subreddit: "r/forhire", stage: "solution_seeking" }, snapshot);
    expect(mixedLead.tier).toBe(2);
  });

  it("returns neutral tier 2 when project lacks sufficient evidence", () => {
    const records = [makeRecord("l1", "customer", "SaaS")];
    const snapshot = buildLearningSnapshot(records);
    expect(snapshot.enoughEvidenceToPrioritize).toBe(false);

    const lead = assessLead({ subreddit: "r/SaaS" }, snapshot);
    expect(lead.tier).toBe(2);
    expect(lead.explanation).toBeUndefined();
  });
});
