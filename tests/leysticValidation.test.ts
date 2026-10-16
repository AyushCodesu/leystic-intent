import { describe, expect, it } from "vitest";
import { PRODUCT_NAME, PRODUCT_URL, SUPPORT_EMAIL, REPO_URL } from "@/lib/brand";
import { gateFailure, decide } from "@/lib/scan/gates";
import { LEAD_OUTCOMES, OUTCOME_LABELS } from "@/lib/feed";
import { isSentinel } from "@/lib/scan/evidence";
import { isVerbatim } from "@/lib/scan/validate";
import { signToken, verifyToken } from "@/lib/alerts/signedLink";
import { actToken, actForToken } from "@/lib/alerts/act";
import type { Assessment } from "@/lib/scan/judgement";

describe("Leystic branding and positioning", () => {
  it("uses Leystic brand name and product URLs", () => {
    expect(PRODUCT_NAME).toBe("Leystic");
    expect(PRODUCT_URL).toBe("https://leystic.com");
    expect(SUPPORT_EMAIL).toBe("support@leystic.com");
    expect(REPO_URL).toBe("https://github.com/AyushCodesu/leystic-intent");
  });

  it("defines standard outcome labels for founder recording", () => {
    expect(LEAD_OUTCOMES).toContain("replied");
    expect(LEAD_OUTCOMES).toContain("meeting_booked");
    expect(LEAD_OUTCOMES).toContain("opportunity");
    expect(LEAD_OUTCOMES).toContain("customer");
    expect(LEAD_OUTCOMES).toContain("not_fit");

    expect(OUTCOME_LABELS.meeting_booked).toBe("Meeting booked");
    expect(OUTCOME_LABELS.opportunity).toBe("Opportunity");
    expect(OUTCOME_LABELS.customer).toBe("Customer");
  });
});

describe("Explainable lead scoring & rejection gates", () => {
  const baseAssessment: Assessment = {
    id: "test-item-1",
    stage: "solution_seeking",
    decision: "qualify",
    reasonCode: "supported_open_need",
    relationship: "buyer",
    needState: "open",
    fit: 3,
    intent: 3,
    quality: 0.85,
    reason: "Explicitly asking for an alternative tool",
    needEvidence: { quote: "looking for an alternative to tool X that is faster" },
  };

  it("qualifies a genuine buyer seeking a solution", () => {
    const failure = gateFailure(baseAssessment);
    expect(failure).toBeNull();
    const verdict = decide(baseAssessment);
    expect(verdict.decision).toBe("qualify");
  });

  it("strictly rejects seller-side and self-promotional posts", () => {
    const sellerItem: Assessment = {
      ...baseAssessment,
      relationship: "seller",
      needEvidence: { quote: "Check out our new tool we just launched!" },
    };
    expect(gateFailure(sellerItem)).toBe("seller_only");
    const verdict = decide(sellerItem);
    expect(verdict.decision).toBe("reject");
    expect(verdict.reasonCode).toBe("seller_only");
  });

  it("strictly rejects helpers offering advice without buying need", () => {
    const helperItem: Assessment = {
      ...baseAssessment,
      relationship: "helper",
      needEvidence: { quote: "You should try using tool Y for that use case" },
    };
    expect(gateFailure(helperItem)).toBe("helper_only");
    const verdict = decide(helperItem);
    expect(verdict.decision).toBe("reject");
    expect(verdict.reasonCode).toBe("helper_only");
  });

  it("rejects conversations where need is already resolved", () => {
    const resolvedItem: Assessment = {
      ...baseAssessment,
      needState: "resolved",
      needEvidence: { quote: "Thanks everyone, we ended up buying Z and it solved our issue." },
    };
    expect(gateFailure(resolvedItem)).toBe("resolved");
    const verdict = decide(resolvedItem);
    expect(verdict.decision).toBe("reject");
    expect(verdict.reasonCode).toBe("resolved");
  });

  it("rejects generic discussion without active need", () => {
    const discussionItem: Assessment = {
      ...baseAssessment,
      relationship: "discussion",
      needState: "no_active_need",
      needEvidence: { quote: "What is your philosophy on B2B pricing?" },
    };
    expect(gateFailure(discussionItem)).toBe("no_active_need");
    const verdict = decide(discussionItem);
    expect(verdict.decision).toBe("reject");
    expect(verdict.reasonCode).toBe("no_active_need");
  });

  it("rejects poor fit (fit 0) when product does not do the job", () => {
    const wrongJobItem: Assessment = {
      ...baseAssessment,
      fit: 0,
      quality: 0.2,
      needEvidence: { quote: "Looking for an ERP system for 50,000 employees" },
    };
    expect(gateFailure(wrongJobItem)).toBe("wrong_job");
    const verdict = decide(wrongJobItem);
    expect(verdict.decision).toBe("reject");
    expect(verdict.reasonCode).toBe("wrong_job");
  });
});

describe("Evidence provenance and quote checking", () => {
  it("identifies deleted or removed sentinel posts", () => {
    expect(isSentinel({ body: "[deleted]", author: "someone" })).toBe(true);
    expect(isSentinel({ body: "[removed]", author: "someone" })).toBe(true);
    expect(isSentinel({ body: "Valid question here", author: "[deleted]" })).toBe(true);
    expect(isSentinel({ body: "Valid question here", author: "active_user" })).toBe(false);
  });

  it("verifies evidence quotes exist in source text", () => {
    const source = "We are currently evaluating form builders and need something with webhook support.";
    const validQuote = "need something with webhook support";
    const invalidQuote = "we want a completely free unlimited tier";

    expect(isVerbatim(validQuote, [source])).toBe(true);
    expect(isVerbatim(invalidQuote, [source])).toBe(false);
  });
});

describe("Outcome tracking and token safety", () => {
  it("safely generates and verifies alert action tokens", () => {
    const action = {
      act: "replied" as const,
      projectId: "proj-123",
      platform: "reddit" as const,
      threadId: "thread-abc",
    };

    const token = actToken(action);
    expect(typeof token).toBe("string");

    const decoded = actForToken(token);
    expect(decoded).toEqual(action);

    // Tampered token must be rejected
    const tampered = token.slice(0, -4) + "XXXX";
    expect(actForToken(tampered)).toBeNull();
  });

  it("verifies signed links reject forged signatures", () => {
    const payload = "user-123";
    const token = signToken("invite", payload);

    expect(verifyToken("invite", token)).toBe(payload);
    expect(verifyToken("invite", token.replace("user-123", "user-999"))).toBeNull();
    expect(verifyToken("different_purpose", token)).toBeNull();
  });
});
