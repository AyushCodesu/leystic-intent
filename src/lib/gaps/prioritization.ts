import type { DemandMatchResult } from "./matching";
import type {
  DemandGapCandidate,
  DemandGroup,
  FounderConfirmation,
  GapPriority,
  WebsiteInspectionSnapshot,
} from "./types";

const PRIORITY_TIERS: Record<GapPriority, number> = {
  high: 1,
  medium: 2,
  developing: 3,
  addressed: 4,
};

/**
 * Builds candidate demand-to-page gaps by combining observed buyer demand,
 * website coverage matching results, and founder confirmations.
 */
export function buildDemandGapCandidates(
  demandGroups: DemandGroup[],
  matchResults: Map<string, DemandMatchResult>,
  confirmations: Map<string, FounderConfirmation>,
  inspectionSnapshot: WebsiteInspectionSnapshot,
): DemandGapCandidate[] {
  const candidates: DemandGapCandidate[] = [];

  for (const group of demandGroups) {
    const match = matchResults.get(group.id) ?? {
      coverage: "insufficient_evidence" as const,
      bestMatch: null,
      alternatives: [],
    };

    const confirmation = confirmations.get(group.id) ?? {
      status: "unconfirmed" as const,
      confirmedPageUrl: null,
      notes: null,
      updatedAt: "",
    };

    const pagesCount = inspectionSnapshot.pagesCount;

    // 1. Determine priority
    let priority: GapPriority;
    let priorityReason: string;

    if (confirmation.status === "confirmed_match") {
      priority = "addressed";
      priorityReason = "Founder confirmed page addresses this buyer demand.";
    } else if (confirmation.status === "confirmed_gap") {
      if (group.threadCount >= 2 || group.outcomeSummary.qualifiedProgressCount >= 1) {
        priority = "high";
        priorityReason = "Founder-confirmed gap with multiple observed buyer conversations.";
      } else {
        priority = "medium";
        priorityReason = "Founder-confirmed gap with single observed conversation.";
      }
    } else if (match.coverage === "no_match_found") {
      if (group.threadCount >= 2 && group.outcomeSummary.qualifiedProgressCount >= 1) {
        priority = "high";
        priorityReason = `${group.threadCount} distinct buyer threads with qualified commercial progress; no matching page found among ${pagesCount} pages inspected.`;
      } else if (group.threadCount >= 2) {
        priority = "high";
        priorityReason = `${group.threadCount} distinct buyer threads; no matching page found among ${pagesCount} pages inspected.`;
      } else if (group.outcomeSummary.qualifiedProgressCount >= 1) {
        priority = "high";
        priorityReason = `Commercial progress recorded; no matching page found among ${pagesCount} pages inspected.`;
      } else {
        priority = "medium";
        priorityReason = `Single observed conversation with no matching page found among ${pagesCount} pages inspected.`;
      }
    } else if (match.coverage === "possible_match") {
      if (group.threadCount >= 2 || group.outcomeSummary.qualifiedProgressCount >= 1) {
        priority = "medium";
        priorityReason = "Multiple conversations; potential page match requires founder review.";
      } else {
        priority = "developing";
        priorityReason = "Single conversation; partial page match under review.";
      }
    } else if (match.coverage === "matched") {
      priority = "addressed";
      priorityReason = `Matching page found: ${match.bestMatch?.pageTitle || match.bestMatch?.pageUrl}`;
    } else {
      priority = "developing";
      priorityReason = "Website not yet inspected or insufficient coverage evidence.";
    }

    // 2. Build three-part scoped explanation
    const communityLabels =
      group.topCommunities.length > 0
        ? group.topCommunities.map((c) => `r/${c}`).join(", ")
        : "public communities";

    const observed = `${group.threadCount} distinct conversation${
      group.threadCount === 1 ? "" : "s"
    } observed in ${communityLabels}. Recorded outcomes: ${
      group.outcomeSummary.qualifiedProgressCount
    } qualified progress, ${group.outcomeSummary.engagementCount} replies, ${
      group.outcomeSummary.notFitCount
    } not a fit.`;

    let whyItMatters: string;
    if (match.coverage === "no_match_found") {
      whyItMatters = `Several relevant conversations were found, but we did not find a clearly matching page among the ${pagesCount} pages inspected. Prospective buyers looking for this solution may not find a dedicated page on your website.`;
    } else if (match.coverage === "possible_match") {
      whyItMatters = `A possible matching page was identified ("${
        match.bestMatch?.pageTitle || match.bestMatch?.pageUrl
      }"), but keyword overlap is partial. Inspect whether it addresses this specific buying question.`;
    } else if (match.coverage === "matched") {
      whyItMatters = `An existing website page ("${
        match.bestMatch?.pageTitle || match.bestMatch?.pageUrl
      }") appears to address this topic.`;
    } else {
      whyItMatters = "Website pages have not yet been successfully inspected to evaluate coverage for this demand.";
    }

    let needsConfirmation: string;
    if (confirmation.status === "unconfirmed") {
      needsConfirmation = "Review candidate page matches or confirm this as an unaddressed demand gap.";
    } else if (confirmation.status === "confirmed_gap") {
      needsConfirmation = "Founder explicitly confirmed that no inspected page addresses this demand.";
    } else if (confirmation.status === "confirmed_match") {
      needsConfirmation = "Founder confirmed matching page coverage.";
    } else {
      needsConfirmation = "Founder noted that the suggested page is only a partial answer.";
    }

    candidates.push({
      id: group.id,
      label: group.topic,
      demandDescription: `Buyers seeking ${group.topic.toLowerCase()}`,
      threadCount: group.threadCount,
      supportingThreads: group.supportingThreads,
      communities: group.topCommunities,
      stages: Object.keys(group.stageCounts),
      outcomeSummary: group.outcomeSummary,
      inspectionScope: {
        inspectedAt: inspectionSnapshot.inspectedAt,
        pagesInspectedCount: pagesCount,
        inspectionStatus: inspectionSnapshot.status,
      },
      pageCoverage: {
        status: match.coverage,
        bestPageUrl: match.bestMatch?.pageUrl ?? null,
        bestPageTitle: match.bestMatch?.pageTitle ?? null,
        matchedTerms: match.bestMatch?.matchedTerms ?? [],
        alternativePages: match.alternatives.map((alt) => ({
          url: alt.pageUrl,
          title: alt.pageTitle,
          status: alt.status,
        })),
      },
      confirmation: {
        status: confirmation.status,
        confirmedPageUrl: confirmation.confirmedPageUrl,
        notes: confirmation.notes,
        updatedAt: confirmation.updatedAt || null,
      },
      priority,
      priorityReason,
      explanation: {
        observed,
        whyItMatters,
        needsConfirmation,
      },
    });
  }

  // 3. Deterministic sorting: priority tier asc, qualifiedProgress desc, threadCount desc, id asc
  return candidates.sort((a, b) => {
    const tierDiff = PRIORITY_TIERS[a.priority] - PRIORITY_TIERS[b.priority];
    if (tierDiff !== 0) return tierDiff;

    if (b.outcomeSummary.qualifiedProgressCount !== a.outcomeSummary.qualifiedProgressCount) {
      return b.outcomeSummary.qualifiedProgressCount - a.outcomeSummary.qualifiedProgressCount;
    }

    if (b.threadCount !== a.threadCount) {
      return b.threadCount - a.threadCount;
    }

    return a.id.localeCompare(b.id);
  });
}
