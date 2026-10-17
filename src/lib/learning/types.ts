/**
 * Outcome learning types for Leystic.
 * Pure deterministic types capturing founder-confirmed lead outcomes and learned patterns.
 */

import type { LeadOutcome } from "@/lib/feed";

export type OutcomeCategory =
  | "qualified_progress"
  | "engagement"
  | "explicit_mismatch"
  | "unlabelled";

export type QualifiedProgressKind = "meeting_booked" | "opportunity" | "customer";

export type PatternDimension = "community" | "stage" | "kind";

export type PatternStatus =
  | "promising"
  | "repeated_mismatch"
  | "mixed"
  | "insufficient_evidence";

export type LabelledLeadRecord = {
  id: string;
  projectId: string;
  outcome: LeadOutcome | string | null;
  outcomeRecordedAt: Date | null;
  outcomeNotes: string | null;
  subreddit: string | null;
  stage: string | null;
  kind: string | null;
};

export type OutcomeLearningPattern = {
  dimension: PatternDimension;
  value: string;

  qualifiedProgressCount: number;
  meetingBookedCount: number;
  opportunityCount: number;
  customerCount: number;
  engagementCount: number;
  notFitCount: number;

  terminalOutcomeCount: number;

  status: PatternStatus;

  supportingLeadIds: string[];
};

export type OutcomeLearningSnapshot = {
  labelledLeadCount: number;
  qualifiedProgressCount: number;
  meetingBookedCount: number;
  opportunityCount: number;
  customerCount: number;
  engagementCount: number;
  notFitCount: number;
  terminalOutcomeCount: number;

  patterns: OutcomeLearningPattern[];

  enoughEvidenceToPrioritize: boolean;

  sampleLimit: number;
  totalSampled: number;
};

export type LeadLearnedAssessment = {
  tier: 1 | 2 | 3; // 1 = boosted/promising, 2 = neutral, 3 = deprioritized/repeated mismatch
  influencingPattern?: OutcomeLearningPattern;
  explanation?: string;
};
