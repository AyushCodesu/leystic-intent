import { describe, expect, it } from "vitest";
import { buildDemandGapCandidates } from "@/lib/gaps/prioritization";
import type {
  DemandGroup,
  FounderConfirmation,
  WebsiteInspectionSnapshot,
} from "@/lib/gaps/types";
import type { DemandMatchResult } from "@/lib/gaps/matching";

describe("buildDemandGapCandidates", () => {
  const dummyInspection: WebsiteInspectionSnapshot = {
    inspectionId: "insp-1",
    status: "success",
    inspectedAt: new Date().toISOString(),
    rootUrl: "https://acme.com",
    pagesCount: 15,
    pages: [],
    error: null,
  };

  it("prioritizes candidate gaps with multiple threads and commercial progress as high priority", () => {
    const demandGroups: DemandGroup[] = [
      {
        id: "dg_crm_sync",
        topic: "CRM Sync",
        normalizedTerms: ["crm", "sync"],
        stageCounts: { switching: 3 },
        topCommunities: ["SaaS"],
        supportingThreads: [
          {
            postId: "p1",
            title: "Need CRM sync",
            url: "https://reddit.com/p1",
            excerpt: "Excerpt 1",
            subreddit: "SaaS",
            stage: "switching",
            outcomes: ["customer"],
            foundAt: new Date().toISOString(),
          },
          {
            postId: "p2",
            title: "HubSpot sync alternative",
            url: "https://reddit.com/p2",
            excerpt: "Excerpt 2",
            subreddit: "SaaS",
            stage: "switching",
            outcomes: ["replied"],
            foundAt: new Date().toISOString(),
          },
        ],
        threadCount: 2,
        outcomeSummary: {
          qualifiedProgressCount: 1,
          engagementCount: 1,
          notFitCount: 0,
          unlabelledCount: 0,
          terminalOutcomeCount: 1,
        },
        weaklySupported: false,
      },
    ];

    const matchResults = new Map<string, DemandMatchResult>([
      [
        "dg_crm_sync",
        {
          coverage: "no_match_found",
          bestMatch: null,
          alternatives: [],
        },
      ],
    ]);

    const confirmations = new Map<string, FounderConfirmation>();

    const candidates = buildDemandGapCandidates(
      demandGroups,
      matchResults,
      confirmations,
      dummyInspection,
    );

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];
    expect(candidate.priority).toBe("high");
    expect(candidate.priorityReason).toContain("qualified commercial progress");
    expect(candidate.explanation.whyItMatters).toContain(
      "did not find a clearly matching page among the 15 pages inspected",
    );
    expect(candidate.explanation.observed).toContain("2 distinct conversations");
  });

  it("does NOT assign high priority to a single unlabelled thread with no match found", () => {
    const demandGroups: DemandGroup[] = [
      {
        id: "dg_obscure_tool",
        topic: "Obscure Tool",
        normalizedTerms: ["obscure", "tool"],
        stageCounts: {},
        topCommunities: ["startups"],
        supportingThreads: [],
        threadCount: 1,
        outcomeSummary: {
          qualifiedProgressCount: 0,
          engagementCount: 0,
          notFitCount: 0,
          unlabelledCount: 1,
          terminalOutcomeCount: 0,
        },
        weaklySupported: true,
      },
    ];

    const matchResults = new Map<string, DemandMatchResult>([
      [
        "dg_obscure_tool",
        {
          coverage: "no_match_found",
          bestMatch: null,
          alternatives: [],
        },
      ],
    ]);

    const candidates = buildDemandGapCandidates(
      demandGroups,
      matchResults,
      new Map(),
      dummyInspection,
    );

    expect(candidates[0].priority).toBe("medium"); // Medium, NOT high!
  });

  it("respects founder confirmation override to mark addressed or confirmed gap", () => {
    const demandGroups: DemandGroup[] = [
      {
        id: "dg_pricing",
        topic: "Pricing Inquiries",
        normalizedTerms: ["pricing"],
        stageCounts: {},
        topCommunities: ["SaaS"],
        supportingThreads: [],
        threadCount: 3,
        outcomeSummary: {
          qualifiedProgressCount: 2,
          engagementCount: 0,
          notFitCount: 0,
          unlabelledCount: 1,
          terminalOutcomeCount: 2,
        },
        weaklySupported: false,
      },
    ];

    const matchResults = new Map<string, DemandMatchResult>([
      [
        "dg_pricing",
        {
          coverage: "no_match_found",
          bestMatch: null,
          alternatives: [],
        },
      ],
    ]);

    const confirmations = new Map<string, FounderConfirmation>([
      [
        "dg_pricing",
        {
          status: "confirmed_match",
          confirmedPageUrl: "https://acme.com/pricing",
          notes: "Pricing exists on /pricing",
          updatedAt: new Date().toISOString(),
        },
      ],
    ]);

    const candidates = buildDemandGapCandidates(
      demandGroups,
      matchResults,
      confirmations,
      dummyInspection,
    );

    expect(candidates[0].priority).toBe("addressed");
    expect(candidates[0].priorityReason).toContain("Founder confirmed page");
  });
});
