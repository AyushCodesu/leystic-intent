import { describe, expect, it } from "vitest";
import { buildLearningSnapshot, assessLead } from "@/lib/learning/engine";
import { PAID_KEYS } from "./testDatabase";
import type { LabelledLeadRecord } from "@/lib/learning/types";

describe("Learning Engine - Immutability & Safe Data Boundaries", () => {
  it("never mutates user outcome records as a side effect of learning", () => {
    const originalRecord: LabelledLeadRecord = Object.freeze({
      id: "lead-freeze-1",
      projectId: "proj-123",
      outcome: "meeting_booked",
      outcomeRecordedAt: new Date("2026-10-10T10:00:00Z"),
      outcomeNotes: "Founder noted customer is exploring migration from tool X",
      subreddit: "SaaS",
      stage: "solution_seeking",
      kind: "buyer",
    });

    const snapshot = buildLearningSnapshot([originalRecord]);
    expect(snapshot.labelledLeadCount).toBe(1);

    // Verify properties on original record are strictly unmodified
    expect(originalRecord.outcome).toBe("meeting_booked");
    expect(originalRecord.outcomeNotes).toBe(
      "Founder noted customer is exploring migration from tool X",
    );
    expect(originalRecord.id).toBe("lead-freeze-1");
  });

  it("operates strictly without requiring paid keys or LLM provider credentials", () => {
    // None of the paid keys should be present in process.env during testing
    for (const key of PAID_KEYS) {
      expect(process.env[key]).toBeUndefined();
    }

    const records: LabelledLeadRecord[] = [
      {
        id: "l1",
        projectId: "proj-local",
        outcome: "customer",
        outcomeRecordedAt: new Date(),
        outcomeNotes: null,
        subreddit: "startups",
        stage: "decision",
        kind: "buyer",
      },
    ];

    // Engine executes pure deterministic TypeScript without model invocation
    const snapshot = buildLearningSnapshot(records);
    expect(snapshot).toBeDefined();
    expect(snapshot.labelledLeadCount).toBe(1);
    expect(snapshot.enoughEvidenceToPrioritize).toBe(false);
  });

  it("empty state renders cleanly without fabricated data or synthetic conversion claims", () => {
    const emptySnapshot = buildLearningSnapshot([]);

    expect(emptySnapshot.labelledLeadCount).toBe(0);
    expect(emptySnapshot.qualifiedProgressCount).toBe(0);
    expect(emptySnapshot.meetingBookedCount).toBe(0);
    expect(emptySnapshot.opportunityCount).toBe(0);
    expect(emptySnapshot.customerCount).toBe(0);
    expect(emptySnapshot.engagementCount).toBe(0);
    expect(emptySnapshot.notFitCount).toBe(0);
    expect(emptySnapshot.terminalOutcomeCount).toBe(0);
    expect(emptySnapshot.patterns).toHaveLength(0);
    expect(emptySnapshot.enoughEvidenceToPrioritize).toBe(false);

    // Assessment on empty snapshot produces neutral tier 2 with no fabricated explanation
    const assessment = assessLead({ subreddit: "r/SaaS" }, emptySnapshot);
    expect(assessment.tier).toBe(2);
    expect(assessment.explanation).toBeUndefined();
    expect(assessment.influencingPattern).toBeUndefined();
  });
});
