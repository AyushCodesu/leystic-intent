import { describe, expect, it } from "vitest";
import { matchDemandToPages } from "@/lib/gaps/matching";
import type { DemandGroup, InspectedPage } from "@/lib/gaps/types";

describe("matchDemandToPages", () => {
  const samplePages: InspectedPage[] = [
    {
      url: "https://acme.com/",
      canonicalUrl: "https://acme.com/",
      title: "Acme | All-in-One Growth Platform",
      description: "Grow your company with our suite of modern tools.",
      h1: "The Platform for Startups",
      headings: ["Analytics", "Marketing", "Integrations"],
      path: "/",
      crawledAt: new Date(),
    },
    {
      url: "https://acme.com/features/form-builder",
      canonicalUrl: "https://acme.com/features/form-builder",
      title: "Embeddable Form Builder",
      description: "Create interactive forms and embed them anywhere.",
      h1: "No-Code Form Builder",
      headings: ["Survey Creator", "CRM Sync"],
      path: "/features/form-builder",
      crawledAt: new Date(),
    },
    {
      url: "https://acme.com/pricing",
      canonicalUrl: "https://acme.com/pricing",
      title: "Pricing Plans",
      description: "Simple pricing for teams of all sizes.",
      h1: "Pricing & Plans",
      headings: ["Starter", "Enterprise"],
      path: "/pricing",
      crawledAt: new Date(),
    },
  ];

  it("identifies a strong match when title, h1, or path contains the demand phrase", () => {
    const demandGroups: DemandGroup[] = [
      {
        id: "dg_form_builder",
        topic: "Form Builder",
        normalizedTerms: ["form", "builder", "form builder"],
        stageCounts: { seeking_alternatives: 2 },
        topCommunities: ["SaaS"],
        supportingThreads: [],
        threadCount: 2,
        outcomeSummary: {
          qualifiedProgressCount: 1,
          engagementCount: 0,
          notFitCount: 0,
          unlabelledCount: 1,
          terminalOutcomeCount: 1,
        },
        weaklySupported: false,
      },
    ];

    const results = matchDemandToPages(demandGroups, samplePages, "success");
    const match = results.get("dg_form_builder");

    expect(match?.coverage).toBe("matched");
    expect(match?.bestMatch?.pageUrl).toBe("https://acme.com/features/form-builder");
    expect(match?.bestMatch?.matchedTerms).toContain("form builder");
  });

  it("identifies a possible match when partial overlap exists in headings or descriptions", () => {
    const demandGroups: DemandGroup[] = [
      {
        id: "dg_surveys",
        topic: "Customer Surveys",
        normalizedTerms: ["customer", "surveys", "customer surveys"],
        stageCounts: { problem_aware: 1 },
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

    const results = matchDemandToPages(demandGroups, samplePages, "success");
    const match = results.get("dg_surveys");

    expect(match?.coverage).toBe("possible_match");
    expect(match?.bestMatch?.pageUrl).toBe("https://acme.com/features/form-builder");
  });

  it("assigns no_match_found when successful inspection finds no overlapping page", () => {
    const demandGroups: DemandGroup[] = [
      {
        id: "dg_invoice",
        topic: "Automated Invoicing",
        normalizedTerms: ["automated", "invoicing", "automated invoicing", "billing"],
        stageCounts: { evaluating: 2 },
        topCommunities: ["startups"],
        supportingThreads: [],
        threadCount: 2,
        outcomeSummary: {
          qualifiedProgressCount: 1,
          engagementCount: 0,
          notFitCount: 0,
          unlabelledCount: 1,
          terminalOutcomeCount: 1,
        },
        weaklySupported: false,
      },
    ];

    const results = matchDemandToPages(demandGroups, samplePages, "success");
    const match = results.get("dg_invoice");

    expect(match?.coverage).toBe("no_match_found");
    expect(match?.bestMatch).toBeNull();
  });

  it("assigns insufficient_evidence when inspection is not completed or failed", () => {
    const demandGroups: DemandGroup[] = [
      {
        id: "dg_invoice",
        topic: "Automated Invoicing",
        normalizedTerms: ["automated", "invoicing"],
        stageCounts: {},
        topCommunities: [],
        supportingThreads: [],
        threadCount: 2,
        outcomeSummary: {
          qualifiedProgressCount: 0,
          engagementCount: 0,
          notFitCount: 0,
          unlabelledCount: 2,
          terminalOutcomeCount: 0,
        },
        weaklySupported: false,
      },
    ];

    const notInspected = matchDemandToPages(demandGroups, [], "not_inspected");
    expect(notInspected.get("dg_invoice")?.coverage).toBe("insufficient_evidence");

    const failed = matchDemandToPages(demandGroups, [], "failed");
    expect(failed.get("dg_invoice")?.coverage).toBe("insufficient_evidence");
  });
});
