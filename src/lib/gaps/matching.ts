import { HIGH_MATCH_SCORE_THRESHOLD, POSSIBLE_MATCH_SCORE_THRESHOLD } from "./constants";
import type { DemandGroup, DemandPageMatch, InspectedPage, PageCoverageStatus } from "./types";

export type DemandMatchResult = {
  coverage: PageCoverageStatus;
  bestMatch: DemandPageMatch | null;
  alternatives: DemandPageMatch[];
};

function stemWord(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 3) return word.slice(0, -1);
  return word;
}

function scorePageForTerms(
  page: InspectedPage,
  topic: string,
  terms: string[],
): { score: number; matchedTerms: string[] } {
  let score = 0;
  const matched = new Set<string>();

  const titleLower = (page.title || "").toLowerCase();
  const descLower = (page.description || "").toLowerCase();
  const h1Lower = (page.h1 || "").toLowerCase();
  const pathLower = (page.path || "").toLowerCase();
  const headingsLower = page.headings.map((h) => h.toLowerCase()).join(" ");

  const topicLower = topic.toLowerCase();
  const topicStem = stemWord(topicLower);

  // 1. Exact or near-exact phrase match
  if (topicLower.length >= 4) {
    if (titleLower.includes(topicLower) || h1Lower.includes(topicLower) || titleLower.includes(topicStem) || h1Lower.includes(topicStem)) {
      score += 10;
      matched.add(topicLower);
    } else if (pathLower.includes(topicLower.replace(/\s+/g, "-")) || pathLower.includes(topicLower.replace(/\s+/g, ""))) {
      score += 8;
      matched.add(topicLower);
    } else if (headingsLower.includes(topicLower) || (topicStem.length >= 4 && headingsLower.includes(topicStem))) {
      score += 6;
      matched.add(topicLower);
    } else if (descLower.includes(topicLower) || (topicStem.length >= 4 && descLower.includes(topicStem))) {
      score += 4;
      matched.add(topicLower);
    }
  }

  // 2. Token and 2-gram overlap
  for (const term of terms) {
    const t = term.toLowerCase();
    const s = stemWord(t);
    const matchesTarget = (target: string) => target.includes(t) || (s.length >= 3 && target.includes(s));
    let termHit = false;

    if (matchesTarget(titleLower)) {
      score += 4;
      termHit = true;
    }
    if (matchesTarget(h1Lower)) {
      score += 4;
      termHit = true;
    }
    if (pathLower.includes(t.replace(/\s+/g, "-")) || (s.length >= 3 && pathLower.includes(s.replace(/\s+/g, "-")))) {
      score += 3;
      termHit = true;
    }
    if (matchesTarget(headingsLower)) {
      score += 2;
      termHit = true;
    }
    if (matchesTarget(descLower)) {
      score += 1;
      termHit = true;
    }

    if (termHit) {
      matched.add(t);
    }
  }

  return { score, matchedTerms: [...matched] };
}

/**
 * Matches candidate buyer demand groups against the inventory of successfully inspected website pages.
 * Returns deterministic page coverage status (matched, possible_match, no_match_found, insufficient_evidence).
 */
export function matchDemandToPages(
  demandGroups: DemandGroup[],
  pages: InspectedPage[],
  inspectionStatus: "success" | "partial" | "failed" | "not_inspected",
): Map<string, DemandMatchResult> {
  const results = new Map<string, DemandMatchResult>();

  for (const group of demandGroups) {
    if (inspectionStatus === "failed" || inspectionStatus === "not_inspected" || pages.length === 0) {
      results.set(group.id, {
        coverage: "insufficient_evidence",
        bestMatch: null,
        alternatives: [],
      });
      continue;
    }

    const scoredPages: DemandPageMatch[] = [];

    for (const page of pages) {
      const { score, matchedTerms } = scorePageForTerms(page, group.topic, group.normalizedTerms);
      if (score >= POSSIBLE_MATCH_SCORE_THRESHOLD) {
        scoredPages.push({
          demandGroupId: group.id,
          pageUrl: page.canonicalUrl || page.url,
          pageTitle: page.title || page.path,
          status: score >= HIGH_MATCH_SCORE_THRESHOLD ? "matched" : "possible_match",
          matchedTerms,
          score,
        });
      }
    }

    // Sort by match score desc
    scoredPages.sort((a, b) => b.score - a.score);

    if (scoredPages.length === 0) {
      results.set(group.id, {
        coverage: "no_match_found",
        bestMatch: null,
        alternatives: [],
      });
    } else {
      const topMatch = scoredPages[0];
      const coverage: PageCoverageStatus =
        topMatch.score >= HIGH_MATCH_SCORE_THRESHOLD ? "matched" : "possible_match";

      results.set(group.id, {
        coverage,
        bestMatch: topMatch,
        alternatives: scoredPages.slice(1, 3),
      });
    }
  }

  return results;
}
