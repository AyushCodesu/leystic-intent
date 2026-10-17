import { categorizeOutcome } from "@/lib/learning";
import type { DemandGroup, SupportingThreadEvidence } from "./types";

const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
  "any", "anyone", "app", "application", "are", "as", "at", "be", "because", "been",
  "before", "being", "below", "between", "both", "but", "by", "can", "could", "did",
  "do", "does", "doing", "down", "during", "each", "few", "for", "from", "further",
  "had", "has", "have", "having", "he", "her", "here", "hers", "herself", "him",
  "himself", "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself",
  "just", "like", "looking", "me", "more", "most", "my", "myself", "no", "nor",
  "not", "of", "off", "on", "once", "only", "or", "other", "ought", "our", "ours",
  "ourselves", "out", "over", "own", "recommend", "recommendation", "recommended",
  "same", "she", "should", "so", "software", "some", "such", "than", "that", "the",
  "their", "theirs", "them", "themselves", "then", "there", "these", "they", "this",
  "those", "through", "to", "tool", "tools", "too", "under", "until", "up", "very",
  "vs", "versus", "want", "wanted", "was", "we", "were", "what", "when", "where",
  "which", "while", "who", "whom", "why", "with", "would", "you", "your", "yours",
  "yourself", "yourselves",
]);

const PREFIX_STRIPPERS = [
  /^looking for (a |an |any )?/i,
  /^alternative(s)? to /i,
  /^best /i,
  /^recommend( me)? (a |an |any )?/i,
  /^anyone (use|know of|using|recommend)( me)?( a | an | any )?/i,
  /^how to /i,
  /^switch(ing)? from /i,
];

export function cleanTopicString(raw: string): string {
  let cleaned = raw.trim();
  for (const pattern of PREFIX_STRIPPERS) {
    cleaned = cleaned.replace(pattern, "");
  }
  return cleaned.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();
}

export function extractNormalizedTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

  const terms = new Set<string>(words);

  // Add 2-word n-grams for richer phrase matching
  for (let i = 0; i < words.length - 1; i++) {
    terms.add(`${words[i]} ${words[i + 1]}`);
  }

  return [...terms];
}

export function formatTopicTitle(raw: string): string {
  const cleaned = cleanTopicString(raw);
  if (!cleaned) return "General inquiry";
  return cleaned
    .split(" ")
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ""))
    .join(" ");
}

export type RawLeadForDemand = {
  id: string;
  postId: string | null;
  title: string | null;
  body: string | null;
  matchedPhrase: string | null;
  stage: string | null;
  reason: string | null;
  outcome: string | null;
  url: string | null;
  commentPermalink: string | null;
  subreddit: string | null;
  foundAt: Date | string | null;
};

/**
 * Deterministically groups observed buyer leads into candidate demand groups.
 * Deduplicates multiple lead records belonging to the same underlying conversation thread (postId).
 */
export function aggregateDemandFromLeads(leads: RawLeadForDemand[]): DemandGroup[] {
  // 1. Deduplicate by thread (postId)
  const threadMap = new Map<
    string,
    {
      postId: string;
      title: string;
      url: string;
      excerpt: string;
      subreddit: string;
      stage: string | null;
      matchedPhrase: string | null;
      reason: string | null;
      outcomes: Set<string>;
      foundAt: string;
    }
  >();

  for (const lead of leads) {
    const threadKey = lead.postId || lead.id;
    const existing = threadMap.get(threadKey);

    const verifiedUrl = lead.commentPermalink || lead.url || `https://www.reddit.com/r/${lead.subreddit || "all"}`;
    const dateStr = lead.foundAt instanceof Date ? lead.foundAt.toISOString() : (lead.foundAt ?? new Date().toISOString());
    const rawExcerpt = lead.reason || lead.title || lead.body || "";
    const excerpt = rawExcerpt.length > 140 ? `${rawExcerpt.slice(0, 137)}...` : rawExcerpt;

    if (!existing) {
      const outcomes = new Set<string>();
      if (lead.outcome) outcomes.add(lead.outcome);
      threadMap.set(threadKey, {
        postId: threadKey,
        title: lead.title || lead.matchedPhrase || "Untitled conversation",
        url: verifiedUrl,
        excerpt,
        subreddit: (lead.subreddit || "all").toLowerCase().replace(/^r\//, ""),
        stage: lead.stage,
        matchedPhrase: lead.matchedPhrase,
        reason: lead.reason,
        outcomes,
        foundAt: dateStr,
      });
    } else {
      if (lead.outcome) {
        existing.outcomes.add(lead.outcome);
      }
      if (!existing.matchedPhrase && lead.matchedPhrase) {
        existing.matchedPhrase = lead.matchedPhrase;
      }
      if (lead.commentPermalink && !existing.url.includes("/comment/")) {
        existing.url = lead.commentPermalink;
      }
    }
  }

  // 2. Cluster threads by deterministic demand concept
  const groupMap = new Map<
    string,
    {
      id: string;
      topic: string;
      terms: Set<string>;
      stages: Record<string, number>;
      communities: Set<string>;
      threads: SupportingThreadEvidence[];
      outcomes: {
        qualifiedProgressCount: number;
        engagementCount: number;
        notFitCount: number;
        unlabelledCount: number;
      };
    }
  >();

  for (const thread of threadMap.values()) {
    // Determine the grouping key
    let candidateKey = "";
    let displayTopic = "";

    if (thread.matchedPhrase && cleanTopicString(thread.matchedPhrase).length >= 3) {
      const cleaned = cleanTopicString(thread.matchedPhrase).toLowerCase();
      candidateKey = `dg_${cleaned.replace(/\s+/g, "_")}`;
      displayTopic = formatTopicTitle(thread.matchedPhrase);
    } else if (thread.title) {
      const terms = extractNormalizedTerms(thread.title);
      if (terms.length > 0) {
        const topTerm = terms[0];
        candidateKey = `dg_${topTerm.replace(/\s+/g, "_")}`;
        displayTopic = formatTopicTitle(topTerm);
      }
    }

    if (!candidateKey) {
      const fallbackStage = thread.stage ? thread.stage.replace(/_/g, " ") : "general demand";
      candidateKey = `dg_${fallbackStage.replace(/\s+/g, "_")}`;
      displayTopic = formatTopicTitle(fallbackStage);
    }

    let group = groupMap.get(candidateKey);
    if (!group) {
      group = {
        id: candidateKey,
        topic: displayTopic,
        terms: new Set<string>(),
        stages: {},
        communities: new Set<string>(),
        threads: [],
        outcomes: {
          qualifiedProgressCount: 0,
          engagementCount: 0,
          notFitCount: 0,
          unlabelledCount: 0,
        },
      };
      groupMap.set(candidateKey, group);
    }

    // Add normalized terms
    const allText = `${thread.matchedPhrase || ""} ${thread.title} ${thread.reason || ""}`;
    for (const term of extractNormalizedTerms(allText)) {
      group.terms.add(term);
    }

    // Add stage
    if (thread.stage) {
      group.stages[thread.stage] = (group.stages[thread.stage] || 0) + 1;
    }

    // Add community
    if (thread.subreddit) {
      group.communities.add(thread.subreddit);
    }

    // Classify thread outcomes
    const outcomeList = [...thread.outcomes];
    if (outcomeList.length === 0) {
      group.outcomes.unlabelledCount += 1;
    } else {
      let hasQualified = false;
      let hasEngagement = false;
      let hasMismatch = false;

      for (const out of outcomeList) {
        const cat = categorizeOutcome(out);
        if (cat === "qualified_progress") hasQualified = true;
        else if (cat === "engagement") hasEngagement = true;
        else if (cat === "explicit_mismatch") hasMismatch = true;
      }

      if (hasQualified) group.outcomes.qualifiedProgressCount += 1;
      else if (hasEngagement) group.outcomes.engagementCount += 1;
      else if (hasMismatch) group.outcomes.notFitCount += 1;
      else group.outcomes.unlabelledCount += 1;
    }

    group.threads.push({
      postId: thread.postId,
      title: thread.title,
      url: thread.url,
      excerpt: thread.excerpt,
      subreddit: thread.subreddit,
      stage: thread.stage,
      outcomes: outcomeList,
      foundAt: thread.foundAt,
    });
  }

  // 3. Assemble and rank demand groups
  const result: DemandGroup[] = [];

  for (const group of groupMap.values()) {
    const threadCount = group.threads.length;
    const terminalCount = group.outcomes.qualifiedProgressCount + group.outcomes.notFitCount;

    result.push({
      id: group.id,
      topic: group.topic,
      normalizedTerms: [...group.terms],
      stageCounts: group.stages,
      topCommunities: [...group.communities],
      supportingThreads: group.threads.sort(
        (a, b) => new Date(b.foundAt).getTime() - new Date(a.foundAt).getTime(),
      ),
      threadCount,
      outcomeSummary: {
        qualifiedProgressCount: group.outcomes.qualifiedProgressCount,
        engagementCount: group.outcomes.engagementCount,
        notFitCount: group.outcomes.notFitCount,
        unlabelledCount: group.outcomes.unlabelledCount,
        terminalOutcomeCount: terminalCount,
      },
      weaklySupported: threadCount === 1 && group.outcomes.qualifiedProgressCount === 0,
    });
  }

  // Deterministic ordering: qualified progress desc, then thread count desc, then id asc
  return result
    .sort((a, b) => {
      if (b.outcomeSummary.qualifiedProgressCount !== a.outcomeSummary.qualifiedProgressCount) {
        return b.outcomeSummary.qualifiedProgressCount - a.outcomeSummary.qualifiedProgressCount;
      }
      if (b.threadCount !== a.threadCount) {
        return b.threadCount - a.threadCount;
      }
      return a.id.localeCompare(b.id);
    })
    .slice(0, 25);
}
