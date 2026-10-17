export type PageCoverageStatus =
  | "matched"
  | "possible_match"
  | "no_match_found"
  | "insufficient_evidence";

export type FounderConfirmationStatus =
  | "unconfirmed"
  | "confirmed_match"
  | "partial_match"
  | "confirmed_gap";

export type GapPriority = "high" | "medium" | "developing" | "addressed";

export type InspectedPage = {
  url: string;
  canonicalUrl: string;
  title: string | null;
  description: string | null;
  h1: string | null;
  headings: string[];
  path: string;
  crawledAt: Date;
};

export type PageInventoryResult = {
  status: "success" | "partial" | "failed";
  pages: InspectedPage[];
  sitemapFound: boolean;
  pagesFound: number;
  pagesCrawled: number;
  error: string | null;
};

export type SupportingThreadEvidence = {
  postId: string;
  title: string;
  url: string;
  excerpt: string;
  subreddit: string;
  stage: string | null;
  outcomes: string[];
  foundAt: string;
};

export type DemandGroup = {
  id: string; // deterministic identifier, e.g. "dg_form_builder"
  topic: string; // human-readable label, e.g. "Form Builder"
  normalizedTerms: string[];
  stageCounts: Record<string, number>;
  topCommunities: string[];
  supportingThreads: SupportingThreadEvidence[];
  threadCount: number;
  outcomeSummary: {
    qualifiedProgressCount: number;
    engagementCount: number;
    notFitCount: number;
    unlabelledCount: number;
    terminalOutcomeCount: number;
  };
  weaklySupported: boolean;
};

export type DemandPageMatch = {
  demandGroupId: string;
  pageUrl: string;
  pageTitle: string | null;
  status: PageCoverageStatus;
  matchedTerms: string[];
  score: number;
};

export type FounderConfirmation = {
  status: FounderConfirmationStatus;
  confirmedPageUrl: string | null;
  notes: string | null;
  updatedAt: string;
};

export type WebsiteInspectionSnapshot = {
  inspectionId: string | null;
  status: "success" | "partial" | "failed" | "not_inspected";
  inspectedAt: string | null;
  rootUrl: string | null;
  pagesCount: number;
  pages: InspectedPage[];
  error: string | null;
};

export type DemandGapCandidate = {
  id: string;
  label: string;
  demandDescription: string;
  threadCount: number;
  supportingThreads: SupportingThreadEvidence[];
  communities: string[];
  stages: string[];
  outcomeSummary: {
    qualifiedProgressCount: number;
    engagementCount: number;
    notFitCount: number;
    unlabelledCount: number;
    terminalOutcomeCount: number;
  };
  inspectionScope: {
    inspectedAt: string | null;
    pagesInspectedCount: number;
    inspectionStatus: "success" | "partial" | "failed" | "not_inspected";
  };
  pageCoverage: {
    status: PageCoverageStatus;
    bestPageUrl: string | null;
    bestPageTitle: string | null;
    matchedTerms: string[];
    alternativePages: { url: string; title: string | null; status: PageCoverageStatus }[];
  };
  confirmation: {
    status: FounderConfirmationStatus;
    confirmedPageUrl: string | null;
    notes: string | null;
    updatedAt: string | null;
  };
  priority: GapPriority;
  priorityReason: string;
  explanation: {
    observed: string;
    whyItMatters: string;
    needsConfirmation: string;
  };
};
