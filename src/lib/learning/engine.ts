/**
 * Deterministic learning engine for Leystic.
 * Pure aggregation and pattern classification deriving reproducible insights from explicit founder outcomes.
 */

import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { leads, redditPosts } from "@/db/schema";
import {
  MIN_PATTERN_TERMINAL_OUTCOMES,
  MIN_PROJECT_LABELLED_LEADS,
  MIN_PROJECT_TERMINAL_OUTCOMES,
  MIN_PROMISING_QUALIFIED_OUTCOMES,
  MIN_REPEATED_MISMATCH_OUTCOMES,
  OUTCOME_SAMPLE_LIMIT,
} from "./constants";
import {
  categorizeOutcome,
  isEngagement,
  isExplicitMismatch,
  isQualifiedProgress,
} from "./semantics";
import type {
  LabelledLeadRecord,
  LeadLearnedAssessment,
  OutcomeLearningPattern,
  OutcomeLearningSnapshot,
  PatternDimension,
  PatternStatus,
} from "./types";

/** Normalizes subreddit names by stripping leading r/ and whitespace, and lowercasing. */
export function normalizeCommunity(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim().toLowerCase();
  const stripped = trimmed.startsWith("r/") ? trimmed.slice(2) : trimmed;
  return stripped.replace(/^\/+|\/+$/g, "") || null;
}

/**
 * Pure classifier for pattern status based on conservative evidence rules.
 */
export function evaluatePatternStatus(
  qualifiedProgressCount: number,
  notFitCount: number,
): PatternStatus {
  const terminalCount = qualifiedProgressCount + notFitCount;
  if (terminalCount < MIN_PATTERN_TERMINAL_OUTCOMES) {
    return "insufficient_evidence";
  }
  if (
    qualifiedProgressCount >= MIN_PROMISING_QUALIFIED_OUTCOMES &&
    qualifiedProgressCount > notFitCount
  ) {
    return "promising";
  }
  if (notFitCount >= MIN_REPEATED_MISMATCH_OUTCOMES && qualifiedProgressCount === 0) {
    return "repeated_mismatch";
  }
  return "mixed";
}

/** Rank for deterministic sorting of patterns. Promising first, then repeated mismatches. */
function patternStatusRank(status: PatternStatus): number {
  switch (status) {
    case "promising":
      return 1;
    case "repeated_mismatch":
      return 2;
    case "mixed":
      return 3;
    case "insufficient_evidence":
      return 4;
  }
}

/**
 * Helper to accumulate pattern counts from a set of lead records.
 */
function buildDimensionPatterns(
  dimension: PatternDimension,
  records: LabelledLeadRecord[],
  keyExtractor: (record: LabelledLeadRecord) => string | null,
): OutcomeLearningPattern[] {
  const groups = new Map<string, LabelledLeadRecord[]>();

  for (const record of records) {
    const rawKey = keyExtractor(record);
    if (!rawKey) continue;
    const key = rawKey.trim();
    if (!key) continue;

    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }

  const patterns: OutcomeLearningPattern[] = [];

  for (const [value, items] of groups.entries()) {
    let qualifiedProgressCount = 0;
    let meetingBookedCount = 0;
    let opportunityCount = 0;
    let customerCount = 0;
    let engagementCount = 0;
    let notFitCount = 0;
    const supportingLeadIds: string[] = [];

    for (const item of items) {
      supportingLeadIds.push(item.id);
      if (isQualifiedProgress(item.outcome)) {
        qualifiedProgressCount += 1;
        if (item.outcome === "meeting_booked") meetingBookedCount += 1;
        if (item.outcome === "opportunity") opportunityCount += 1;
        if (item.outcome === "customer") customerCount += 1;
      } else if (isEngagement(item.outcome)) {
        engagementCount += 1;
      } else if (isExplicitMismatch(item.outcome)) {
        notFitCount += 1;
      }
    }

    const terminalOutcomeCount = qualifiedProgressCount + notFitCount;
    const status = evaluatePatternStatus(qualifiedProgressCount, notFitCount);

    patterns.push({
      dimension,
      value,
      qualifiedProgressCount,
      meetingBookedCount,
      opportunityCount,
      customerCount,
      engagementCount,
      notFitCount,
      terminalOutcomeCount,
      status,
      supportingLeadIds,
    });
  }

  return patterns;
}

/**
 * Pure engine that builds an OutcomeLearningSnapshot from an array of lead records.
 * Deduplicates by lead ID and guarantees deterministic output.
 */
export function buildLearningSnapshot(
  rawRecords: LabelledLeadRecord[],
  sampleLimit: number = OUTCOME_SAMPLE_LIMIT,
): OutcomeLearningSnapshot {
  // Deduplicate records by ID
  const uniqueMap = new Map<string, LabelledLeadRecord>();
  for (const rec of rawRecords) {
    if (!uniqueMap.has(rec.id)) {
      uniqueMap.set(rec.id, rec);
    }
  }

  // Filter for valid recognized outcomes only
  const validRecords = [...uniqueMap.values()].filter(
    (rec) => categorizeOutcome(rec.outcome) !== "unlabelled",
  );

  let qualifiedProgressCount = 0;
  let meetingBookedCount = 0;
  let opportunityCount = 0;
  let customerCount = 0;
  let engagementCount = 0;
  let notFitCount = 0;

  for (const rec of validRecords) {
    if (isQualifiedProgress(rec.outcome)) {
      qualifiedProgressCount += 1;
      if (rec.outcome === "meeting_booked") meetingBookedCount += 1;
      if (rec.outcome === "opportunity") opportunityCount += 1;
      if (rec.outcome === "customer") customerCount += 1;
    } else if (isEngagement(rec.outcome)) {
      engagementCount += 1;
    } else if (isExplicitMismatch(rec.outcome)) {
      notFitCount += 1;
    }
  }

  const labelledLeadCount = validRecords.length;
  const terminalOutcomeCount = qualifiedProgressCount + notFitCount;
  const enoughEvidenceToPrioritize =
    labelledLeadCount >= MIN_PROJECT_LABELLED_LEADS &&
    terminalOutcomeCount >= MIN_PROJECT_TERMINAL_OUTCOMES;

  // Build patterns across stable categorical dimensions
  const communityPatterns = buildDimensionPatterns("community", validRecords, (r) =>
    normalizeCommunity(r.subreddit),
  );
  const stagePatterns = buildDimensionPatterns("stage", validRecords, (r) => r.stage);
  const kindPatterns = buildDimensionPatterns("kind", validRecords, (r) => r.kind);

  const allPatterns = [...communityPatterns, ...stagePatterns, ...kindPatterns];

  // Sort patterns deterministically
  allPatterns.sort((a, b) => {
    const rankDiff = patternStatusRank(a.status) - patternStatusRank(b.status);
    if (rankDiff !== 0) return rankDiff;
    const termDiff = b.terminalOutcomeCount - a.terminalOutcomeCount;
    if (termDiff !== 0) return termDiff;
    const qualDiff = b.qualifiedProgressCount - a.qualifiedProgressCount;
    if (qualDiff !== 0) return qualDiff;
    return a.value.localeCompare(b.value);
  });

  return {
    labelledLeadCount,
    qualifiedProgressCount,
    meetingBookedCount,
    opportunityCount,
    customerCount,
    engagementCount,
    notFitCount,
    terminalOutcomeCount,
    patterns: allPatterns,
    enoughEvidenceToPrioritize,
    sampleLimit,
    totalSampled: uniqueMap.size,
  };
}

/**
 * Assesses an individual lead against a learning snapshot to determine its learned tier and explanation.
 */
export function assessLead(
  lead: { subreddit?: string | null; stage?: string | null; kind?: string | null },
  snapshot: OutcomeLearningSnapshot,
): LeadLearnedAssessment {
  if (!snapshot.enoughEvidenceToPrioritize) {
    return { tier: 2 };
  }

  const sub = normalizeCommunity(lead.subreddit);
  const stage = lead.stage ? lead.stage.trim() : null;
  const kind = lead.kind ? lead.kind.trim() : null;

  const promisingPatterns = snapshot.patterns.filter((p) => p.status === "promising");
  const mismatchPatterns = snapshot.patterns.filter((p) => p.status === "repeated_mismatch");

  const matchingPromising = promisingPatterns.filter(
    (p) =>
      (p.dimension === "community" && sub === p.value) ||
      (p.dimension === "stage" && stage === p.value) ||
      (p.dimension === "kind" && kind === p.value),
  );

  const matchingMismatch = mismatchPatterns.filter(
    (p) =>
      (p.dimension === "community" && sub === p.value) ||
      (p.dimension === "stage" && stage === p.value) ||
      (p.dimension === "kind" && kind === p.value),
  );

  if (matchingPromising.length > 0 && matchingMismatch.length === 0) {
    const top = matchingPromising[0];
    const dimLabel = top.dimension === "community" ? `r/${top.value}` : top.value;
    return {
      tier: 1,
      influencingPattern: top,
      explanation: `Prioritized: ${dimLabel} has ${top.qualifiedProgressCount} qualified-progress outcome${top.qualifiedProgressCount === 1 ? "" : "s"} (${top.notFitCount} marked not a fit).`,
    };
  }

  if (matchingMismatch.length > 0 && matchingPromising.length === 0) {
    const top = matchingMismatch[0];
    const dimLabel = top.dimension === "community" ? `r/${top.value}` : top.value;
    return {
      tier: 3,
      influencingPattern: top,
      explanation: `Deprioritized: ${dimLabel} has ${top.notFitCount} recorded not-a-fit outcome${top.notFitCount === 1 ? "" : "s"} and 0 qualified-progress outcomes.`,
    };
  }

  return { tier: 2 };
}

/**
 * Queries persisted project-scoped lead outcomes from the database and derives the learning snapshot.
 * Bounded by sampleLimit and strictly isolated to the given projectId.
 */
export async function getProjectLearningSnapshot(
  projectId: string,
  sampleLimit: number = OUTCOME_SAMPLE_LIMIT,
): Promise<OutcomeLearningSnapshot> {
  const rows = await db()
    .select({
      id: leads.id,
      projectId: leads.projectId,
      outcome: leads.outcome,
      outcomeRecordedAt: leads.outcomeRecordedAt,
      outcomeNotes: leads.outcomeNotes,
      subreddit: redditPosts.subreddit,
      stage: leads.stage,
      kind: leads.kind,
    })
    .from(leads)
    .innerJoin(redditPosts, eq(redditPosts.id, leads.postId))
    .where(
      and(
        eq(leads.projectId, projectId),
        isNotNull(leads.outcome),
        ne(leads.outcome, ""),
      ),
    )
    .orderBy(desc(leads.outcomeRecordedAt), desc(leads.scoredAt), desc(leads.id))
    .limit(sampleLimit);

  return buildLearningSnapshot(rows, sampleLimit);
}
