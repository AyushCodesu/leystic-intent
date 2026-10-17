import { describe, expect, it } from "vitest";
import { aggregateDemandFromLeads, cleanTopicString, type RawLeadForDemand } from "@/lib/gaps/demand";

describe("cleanTopicString", () => {
  it("removes common prefixes and punctuation", () => {
    expect(cleanTopicString("looking for a form builder")).toBe("form builder");
    expect(cleanTopicString("alternative to Typeform!")).toBe("Typeform");
    expect(cleanTopicString("best crm for startups")).toBe("crm for startups");
    expect(cleanTopicString("anyone recommend an email finder")).toBe("email finder");
  });
});

describe("aggregateDemandFromLeads", () => {
  it("deduplicates leads by thread (postId) so multiple leads in one post do not inflate counts", () => {
    const rawLeads: RawLeadForDemand[] = [
      {
        id: "lead-1",
        postId: "post-100",
        title: "Looking for a form builder",
        body: "Need drag and drop forms",
        matchedPhrase: "form builder",
        stage: "seeking_alternatives",
        reason: "User wants forms",
        outcome: "replied",
        url: "https://www.reddit.com/r/SaaS/comments/post-100",
        commentPermalink: null,
        subreddit: "SaaS",
        foundAt: new Date(),
      },
      {
        id: "lead-2",
        postId: "post-100", // Same thread!
        title: "Looking for a form builder",
        body: "A comment inside the same thread",
        matchedPhrase: "form builder",
        stage: "seeking_alternatives",
        reason: "Comment asking again",
        outcome: "meeting_booked", // Upgrades the thread's commercial outcome
        url: "https://www.reddit.com/r/SaaS/comments/post-100",
        commentPermalink: "https://www.reddit.com/r/SaaS/comments/post-100/comment/c1",
        subreddit: "SaaS",
        foundAt: new Date(),
      },
    ];

    const groups = aggregateDemandFromLeads(rawLeads);

    expect(groups).toHaveLength(1);
    expect(groups[0].threadCount).toBe(1); // 1 thread, NOT 2
    expect(groups[0].supportingThreads).toHaveLength(1);
    expect(groups[0].outcomeSummary.qualifiedProgressCount).toBe(1); // meeting_booked captured
    expect(groups[0].supportingThreads[0].url).toBe(
      "https://www.reddit.com/r/SaaS/comments/post-100/comment/c1",
    );
  });

  it("classifies outcomes strictly according to Learning V1 semantics", () => {
    const rawLeads: RawLeadForDemand[] = [
      {
        id: "l-1",
        postId: "p-1",
        title: "Need invoice tool",
        body: "invoicing",
        matchedPhrase: "invoice tool",
        stage: "problem_aware",
        reason: "reason",
        outcome: "meeting_booked",
        url: "https://reddit.com/p1",
        commentPermalink: null,
        subreddit: "startups",
        foundAt: new Date(),
      },
      {
        id: "l-2",
        postId: "p-2",
        title: "Need invoice tool",
        body: "invoicing",
        matchedPhrase: "invoice tool",
        stage: "problem_aware",
        reason: "reason",
        outcome: "opportunity",
        url: "https://reddit.com/p2",
        commentPermalink: null,
        subreddit: "startups",
        foundAt: new Date(),
      },
      {
        id: "l-3",
        postId: "p-3",
        title: "Need invoice tool",
        body: "invoicing",
        matchedPhrase: "invoice tool",
        stage: "problem_aware",
        reason: "reason",
        outcome: "customer",
        url: "https://reddit.com/p3",
        commentPermalink: null,
        subreddit: "startups",
        foundAt: new Date(),
      },
      {
        id: "l-4",
        postId: "p-4",
        title: "Need invoice tool",
        body: "invoicing",
        matchedPhrase: "invoice tool",
        stage: "problem_aware",
        reason: "reason",
        outcome: "replied", // Engagement, not qualified progress
        url: "https://reddit.com/p4",
        commentPermalink: null,
        subreddit: "startups",
        foundAt: new Date(),
      },
      {
        id: "l-5",
        postId: "p-5",
        title: "Need invoice tool",
        body: "invoicing",
        matchedPhrase: "invoice tool",
        stage: "problem_aware",
        reason: "reason",
        outcome: "not_fit", // Mismatch
        url: "https://reddit.com/p5",
        commentPermalink: null,
        subreddit: "startups",
        foundAt: new Date(),
      },
      {
        id: "l-6",
        postId: "p-6",
        title: "Need invoice tool",
        body: "invoicing",
        matchedPhrase: "invoice tool",
        stage: "problem_aware",
        reason: "reason",
        outcome: null, // Unlabelled, never treated as failure
        url: "https://reddit.com/p6",
        commentPermalink: null,
        subreddit: "startups",
        foundAt: new Date(),
      },
    ];

    const groups = aggregateDemandFromLeads(rawLeads);

    expect(groups).toHaveLength(1);
    const summary = groups[0].outcomeSummary;
    expect(summary.qualifiedProgressCount).toBe(3); // meeting, opportunity, customer
    expect(summary.engagementCount).toBe(1); // replied
    expect(summary.notFitCount).toBe(1); // not_fit
    expect(summary.unlabelledCount).toBe(1); // null
    expect(summary.terminalOutcomeCount).toBe(4); // 3 qualified + 1 not_fit
  });

  it("marks single unlabelled threads as weakly supported", () => {
    const rawLeads: RawLeadForDemand[] = [
      {
        id: "l-1",
        postId: "p-1",
        title: "One isolated question about billing",
        body: "billing",
        matchedPhrase: "billing tool",
        stage: "evaluating",
        reason: "reason",
        outcome: null,
        url: "https://reddit.com/p1",
        commentPermalink: null,
        subreddit: "SaaS",
        foundAt: new Date(),
      },
    ];

    const groups = aggregateDemandFromLeads(rawLeads);
    expect(groups[0].weaklySupported).toBe(true);
  });
});
