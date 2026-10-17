import { describe, expect, it } from "vitest";
import {
  buildLearnedFeedOrder,
  buildLearnedTierSql,
  DEFAULT_FEED_ORDER,
} from "@/lib/learning/ordering";
import { buildLearningSnapshot } from "@/lib/learning/engine";
import { feedFilter, toCard, toRow } from "@/lib/feed";
import type { FeedLead } from "@/lib/leads";
import type { LabelledLeadRecord } from "@/lib/learning/types";

describe("Learned Feed Prioritization & Ordering", () => {
  const baseDate = new Date("2026-10-15T12:00:00Z");

  function makeRecord(
    id: string,
    outcome: string,
    subreddit = "SaaS",
    stage = "solution_seeking",
  ): LabelledLeadRecord {
    return {
      id,
      projectId: "proj-1",
      outcome,
      outcomeRecordedAt: baseDate,
      outcomeNotes: null,
      subreddit,
      stage,
      kind: "buyer",
    };
  }

  it("returns DEFAULT_FEED_ORDER when project lacks sufficient evidence", () => {
    // 2 labelled leads -> insufficient evidence
    const records = [makeRecord("l1", "customer"), makeRecord("l2", "meeting_booked")];
    const snapshot = buildLearningSnapshot(records);
    expect(snapshot.enoughEvidenceToPrioritize).toBe(false);

    const order = buildLearnedFeedOrder(snapshot);
    expect(order).toEqual(DEFAULT_FEED_ORDER);

    const tierSql = buildLearnedTierSql(snapshot);
    // When insufficient, returns literal 2
    expect(tierSql).toBeDefined();
  });

  it("builds learned tier SQL when evidence threshold is met", () => {
    const records = [
      makeRecord("l1", "customer", "SaaS", "solution_seeking"),
      makeRecord("l2", "customer", "SaaS", "solution_seeking"),
      makeRecord("l3", "customer", "SaaS", "solution_seeking"),
      makeRecord("l4", "not_fit", "SaaS", "solution_seeking"),
      makeRecord("l5", "not_fit", "forhire", "problem_awareness"),
      makeRecord("l6", "not_fit", "forhire", "problem_awareness"),
      makeRecord("l7", "not_fit", "forhire", "problem_awareness"),
      makeRecord("l8", "not_fit", "forhire", "problem_awareness"),
    ];
    const snapshot = buildLearningSnapshot(records);
    expect(snapshot.enoughEvidenceToPrioritize).toBe(true);

    const order = buildLearnedFeedOrder(snapshot);
    expect(order).not.toEqual(DEFAULT_FEED_ORDER);
    expect(order.length).toBeGreaterThan(DEFAULT_FEED_ORDER.length);

    const tierSql = buildLearnedTierSql(snapshot);
    expect(tierSql).toBeDefined();
  });

  it("never alters original model scores or judgements on leads", () => {
    const mockLead: FeedLead = {
      id: "lead-abc",
      score: 87,
      quality: 0.82,
      fit: 3,
      intent: 4,
      engagement: 3,
      stage: "solution_seeking",
      reason: "Looking for an analytics alternative",
      matchedPhrase: "alternative to tool X",
      status: "new",
      kind: "buyer",
      outcome: null,
      outcomeRecordedAt: null,
      outcomeNotes: null,
      postId: "post-1",
      title: "Need tool recommendations",
      subreddit: "SaaS",
      postAuthor: "founder_alice",
      postAuthorAvatar: null,
      url: "https://reddit.com/r/SaaS/comments/123",
      numComments: 5,
      postScore: 12,
      imageUrl: null,
      createdAt: baseDate,
      body: "Our team needs an alternative to tool X",
      subredditIconUrl: null,
      promoPolicy: "allowed",
      rulesText: null,
      commentId: null,
      commentPermalink: null,
      bodyObservedAt: baseDate,
      commentsObservedAt: baseDate,
      commentBody: null,
      commentAuthor: null,
      commentScore: null,
      commentCreatedAt: null,
      authorAvatar: null,
      authorKarma: 150,
      authorCreatedAt: baseDate,
      subredditWeeklyActive: 10000,
      learnedTier: 1,
      learnedExplanation: "Prioritized: r/saas has 3 qualified-progress outcomes",
    };

    const card = toCard(mockLead);
    expect((card as Record<string, unknown>).score).toBeUndefined(); // CardLead has quality/fit/intent
    expect(card.quality).toBe(0.82);
    expect(card.fit).toBe(3);
    expect(card.intent).toBe(4);
    expect(card.learnedTier).toBe(1);
    expect(card.learnedExplanation).toContain("Prioritized: r/saas has 3 qualified-progress outcomes");

    const row = toRow(mockLead);
    expect(row.fit).toBe(3);
    expect(row.intent).toBe(4);
    expect(row.learnedTier).toBe(1);
  });

  it("preserves all existing feed filters when order is set to learned or score", () => {
    const filterLearned = feedFilter({
      status: "new",
      days: "7",
      subreddit: "saas",
      stage: "solution_seeking",
      order: "learned",
    });

    expect(filterLearned.status).toBe("new");
    expect(filterLearned.days).toBe(7);
    expect(filterLearned.subreddit).toBe("saas");
    expect(filterLearned.stage).toBe("solution_seeking");
    expect(filterLearned.order).toBe("learned");

    const filterDefault = feedFilter({
      status: "new",
      days: "30",
      order: "score",
    });

    expect(filterDefault.order).toBe("score");
  });

  it("strictly derives learning results from project-scoped records without cross-tenant mixing", () => {
    const projectARecords = [
      makeRecord("la1", "customer", "SaaS", "solution_seeking"),
      makeRecord("la2", "customer", "SaaS", "solution_seeking"),
      makeRecord("la3", "customer", "SaaS", "solution_seeking"),
      makeRecord("la4", "not_fit", "SaaS", "solution_seeking"),
      makeRecord("la5", "customer", "SaaS", "solution_seeking"),
    ];

    const projectBRecords = [
      makeRecord("lb1", "not_fit", "SaaS", "solution_seeking"),
      makeRecord("lb2", "not_fit", "SaaS", "solution_seeking"),
      makeRecord("lb3", "not_fit", "SaaS", "solution_seeking"),
      makeRecord("lb4", "not_fit", "SaaS", "solution_seeking"),
      makeRecord("lb5", "not_fit", "SaaS", "solution_seeking"),
    ];

    const snapA = buildLearningSnapshot(projectARecords);
    const snapB = buildLearningSnapshot(projectBRecords);

    // Project A shows SaaS as promising
    const saasA = snapA.patterns.find((p) => p.value === "saas");
    expect(saasA?.status).toBe("promising");
    expect(saasA?.qualifiedProgressCount).toBe(4);

    // Project B shows SaaS as repeated mismatch
    const saasB = snapB.patterns.find((p) => p.value === "saas");
    expect(saasB?.status).toBe("repeated_mismatch");
    expect(saasB?.qualifiedProgressCount).toBe(0);
    expect(saasB?.notFitCount).toBe(5);
  });
});
