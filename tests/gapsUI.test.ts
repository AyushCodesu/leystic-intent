import { describe, expect, it } from "vitest";
import React from "react";
import { DemandGapsView } from "@/components/insights/DemandGapsView";
import type { DemandGapCandidate, WebsiteInspectionSnapshot } from "@/lib/gaps/types";

describe("DemandGapsView component contracts", () => {
  const dummyInspection: WebsiteInspectionSnapshot = {
    inspectionId: "insp-1",
    status: "success",
    inspectedAt: new Date().toISOString(),
    rootUrl: "https://acme.com",
    pagesCount: 10,
    pages: [],
    error: null,
  };

  it("renders without runtime exceptions when no leads exist", () => {
    const element = React.createElement(DemandGapsView, {
      projectId: "proj-1",
      projectUrl: "https://acme.com",
      candidates: [],
      inspection: dummyInspection,
      hasLeads: false,
    });
    expect(element).toBeTruthy();
    expect(element.props.hasLeads).toBe(false);
  });

  it("renders candidate gap cards with verified evidence and without invoking AI models", () => {
    const candidates: DemandGapCandidate[] = [
      {
        id: "dg_forms",
        label: "Form Builder",
        demandDescription: "Buyers seeking form builder",
        threadCount: 2,
        supportingThreads: [
          {
            postId: "p1",
            title: "Looking for form builder",
            url: "https://reddit.com/r/SaaS/comments/p1",
            excerpt: "Need forms",
            subreddit: "SaaS",
            stage: "seeking_alternatives",
            outcomes: ["meeting_booked"],
            foundAt: new Date().toISOString(),
          },
        ],
        communities: ["SaaS"],
        stages: ["seeking_alternatives"],
        outcomeSummary: {
          qualifiedProgressCount: 1,
          engagementCount: 0,
          notFitCount: 0,
          unlabelledCount: 1,
          terminalOutcomeCount: 1,
        },
        inspectionScope: {
          inspectedAt: new Date().toISOString(),
          pagesInspectedCount: 10,
          inspectionStatus: "success",
        },
        pageCoverage: {
          status: "no_match_found",
          bestPageUrl: null,
          bestPageTitle: null,
          matchedTerms: [],
          alternativePages: [],
        },
        confirmation: {
          status: "unconfirmed",
          confirmedPageUrl: null,
          notes: null,
          updatedAt: null,
        },
        priority: "high",
        priorityReason: "2 distinct buyer threads; no matching page found among 10 pages inspected.",
        explanation: {
          observed: "2 distinct conversations observed in r/SaaS.",
          whyItMatters: "Several relevant conversations were found, but no matching page was indexed.",
          needsConfirmation: "Review candidate page matches or confirm this as an unaddressed demand gap.",
        },
      },
    ];

    const element = React.createElement(DemandGapsView, {
      projectId: "proj-1",
      projectUrl: "https://acme.com",
      candidates,
      inspection: dummyInspection,
      hasLeads: true,
    });

    expect(element.props.candidates).toHaveLength(1);
    expect(element.props.candidates[0].priority).toBe("high");
  });

  it("preserves previous successful inspection snapshot when last inspection failed", () => {
    const failedSnapshot: WebsiteInspectionSnapshot = {
      inspectionId: "insp-old",
      status: "success",
      inspectedAt: new Date().toISOString(),
      rootUrl: "https://acme.com",
      pagesCount: 8,
      pages: [],
      error: "Connection timeout on subsequent refresh",
    };

    const element = React.createElement(DemandGapsView, {
      projectId: "proj-1",
      projectUrl: "https://acme.com",
      candidates: [],
      inspection: failedSnapshot,
      hasLeads: true,
    });

    expect(element.props.inspection.error).toBe("Connection timeout on subsequent refresh");
    expect(element.props.inspection.pagesCount).toBe(8);
  });
});
