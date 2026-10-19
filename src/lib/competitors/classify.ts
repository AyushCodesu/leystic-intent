import { z } from "zod";
import { generateStructured } from "@/lib/llm";

export const SENTIMENTS = ["positive", "neutral", "negative"] as const;

export type Sentiment = (typeof SENTIMENTS)[number];

export const ABOUTNESS = ["the_product", "in_passing"] as const;

export type Aboutness = (typeof ABOUTNESS)[number];

export const REASON_CATEGORIES = [
  "pricing_value",
  "missing_capability",
  "usability",
  "reliability",
  "performance",
  "integrations",
  "support",
  "recommendation_value_delivered",
  "other",
  "unknown",
] as const;

export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

export const REASON_CATEGORY_LABELS: Record<ReasonCategory, string> = {
  pricing_value: "Pricing / Value",
  missing_capability: "Missing Capability",
  usability: "Usability",
  reliability: "Reliability",
  performance: "Performance",
  integrations: "Integrations",
  support: "Support",
  recommendation_value_delivered: "Recommendation / Value Delivered",
  other: "Other",
  unknown: "Unknown",
};

export const SWITCHING_EVIDENCE = [
  "actively_switching",
  "evaluating_alternatives",
  "dissatisfied_no_switch",
  "positive_recommendation",
  "no_clear_signal",
] as const;

export type SwitchingEvidence = (typeof SWITCHING_EVIDENCE)[number];

export const SWITCHING_EVIDENCE_LABELS: Record<SwitchingEvidence, string> = {
  actively_switching: "Actively switching",
  evaluating_alternatives: "Evaluating alternatives",
  dissatisfied_no_switch: "Dissatisfied without switching evidence",
  positive_recommendation: "Positive recommendation / satisfaction",
  no_clear_signal: "No clear signal",
};

const NEGATION_PATTERNS: readonly RegExp[] = [
  /\bnot\s+(?:actively\s+)?(?:switching|leaving|moving)\b/i,
  /\b(?:cannot|can't|cant|won't|wont|never)\s+(?:switch|leave|move)\b/i,
  /\bstaying\b/i,
  /\bno\s+switch\b/i,
  /\bwill\s+not\s+(?:switch|leave)\b/i,
];

const SWITCHING_ALIAS_MAP: Record<string, SwitchingEvidence> = {
  actively_switching: "actively_switching",
  "actively switching": "actively_switching",
  active_switching: "actively_switching",
  "active switching": "actively_switching",
  migrating: "actively_switching",
  "migrating away": "actively_switching",
  "migrating off": "actively_switching",
  migrated: "actively_switching",
  "migrated away": "actively_switching",
  cancelled: "actively_switching",
  canceled: "actively_switching",
  "cancelled subscription": "actively_switching",
  "canceled subscription": "actively_switching",
  "cancelled our subscription": "actively_switching",
  "canceled our subscription": "actively_switching",
  "cancelling subscription": "actively_switching",
  "canceling subscription": "actively_switching",
  "switching away": "actively_switching",
  switched: "actively_switching",
  dumping: "actively_switching",
  "migrated to another tool": "actively_switching",

  evaluating_alternatives: "evaluating_alternatives",
  "evaluating alternatives": "evaluating_alternatives",
  evaluating_alternative: "evaluating_alternatives",
  "evaluating alternative": "evaluating_alternatives",
  "evaluating options": "evaluating_alternatives",
  "looking for alternatives": "evaluating_alternatives",
  "looking for alternative": "evaluating_alternatives",
  "looking for replacement": "evaluating_alternatives",
  "looking for replacements": "evaluating_alternatives",
  "seeking alternatives": "evaluating_alternatives",
  "seeking alternative": "evaluating_alternatives",
  "considering alternatives": "evaluating_alternatives",
  "considering alternative": "evaluating_alternatives",
  "considering replacement": "evaluating_alternatives",
  "alternative sought": "evaluating_alternatives",
  "exploring alternatives": "evaluating_alternatives",

  dissatisfied_no_switch: "dissatisfied_no_switch",
  "dissatisfied no switch": "dissatisfied_no_switch",
  "dissatisfied without switching evidence": "dissatisfied_no_switch",
  "dissatisfied without switching": "dissatisfied_no_switch",
  dissatisfied: "dissatisfied_no_switch",
  complaint: "dissatisfied_no_switch",
  "frustrated without switching": "dissatisfied_no_switch",
  "frustrated with bug": "dissatisfied_no_switch",

  positive_recommendation: "positive_recommendation",
  "positive recommendation": "positive_recommendation",
  "positive recommendation / satisfaction": "positive_recommendation",
  "positive recommendation satisfaction": "positive_recommendation",
  recommendation: "positive_recommendation",
  satisfaction: "positive_recommendation",
  satisfied: "positive_recommendation",
  "recommends product": "positive_recommendation",

  no_clear_signal: "no_clear_signal",
  "no clear signal": "no_clear_signal",
  "no signal": "no_clear_signal",
  unknown: "no_clear_signal",
  unclear: "no_clear_signal",
  neutral: "no_clear_signal",
  none: "no_clear_signal",
};

const REASON_ALIAS_MAP: Record<string, ReasonCategory> = {
  pricing_value: "pricing_value",
  "pricing value": "pricing_value",
  "pricing / value": "pricing_value",
  pricing: "pricing_value",
  price: "pricing_value",
  cost: "pricing_value",
  expensive: "pricing_value",
  "pricing tiers": "pricing_value",

  missing_capability: "missing_capability",
  "missing capability": "missing_capability",
  "missing feature": "missing_capability",
  "capability limitation": "missing_capability",
  "feature limitation": "missing_capability",

  usability: "usability",
  ui: "usability",
  ux: "usability",
  "user experience": "usability",
  "complex ux": "usability",
  "confusing workflow": "usability",
  "clunky ui": "usability",
  "ease of use": "usability",

  reliability: "reliability",
  uptime: "reliability",
  downtime: "reliability",
  bugs: "reliability",
  bug: "reliability",
  outage: "reliability",
  "data loss": "reliability",
  crash: "reliability",

  performance: "performance",
  speed: "performance",
  slow: "performance",
  latency: "performance",
  "load time": "performance",
  fast: "performance",
  lag: "performance",

  integrations: "integrations",
  integration: "integrations",
  api: "integrations",
  webhook: "integrations",
  webhooks: "integrations",
  zapier: "integrations",
  "hubspot sync": "integrations",

  support: "support",
  "customer service": "support",
  "customer support": "support",
  "ticket response": "support",
  documentation: "support",

  recommendation_value_delivered: "recommendation_value_delivered",
  "recommendation / value delivered": "recommendation_value_delivered",
  "recommendation value delivered": "recommendation_value_delivered",
  "value delivered": "recommendation_value_delivered",
  recommendation: "recommendation_value_delivered",
  endorsement: "recommendation_value_delivered",

  other: "other",
  unknown: "unknown",
  none: "unknown",
  unclear: "unknown",
};

export const reasonCategorySchema = z.preprocess((val) => {
  if (typeof val !== "string") return "unknown";
  const cleaned = val.trim().toLowerCase().replace(/\s+/g, " ");
  if (REASON_CATEGORIES.includes(cleaned as ReasonCategory)) {
    return cleaned as ReasonCategory;
  }
  const snake = cleaned.replace(/[\s\/-]+/g, "_");
  if (REASON_CATEGORIES.includes(snake as ReasonCategory)) {
    return snake as ReasonCategory;
  }
  if (cleaned in REASON_ALIAS_MAP) {
    return REASON_ALIAS_MAP[cleaned];
  }
  if (snake in REASON_ALIAS_MAP) {
    return REASON_ALIAS_MAP[snake];
  }
  if (/\b(?:pricing|price|cost|expensive|tiers?)\b/i.test(cleaned)) {
    return "pricing_value";
  }
  if (/\b(?:missing|features?|capabilities?|limitations?)\b/i.test(cleaned)) {
    return "missing_capability";
  }
  if (/\b(?:usability|ux|ui|complex|confusing|confuse|clunky|flow|ease)\b/i.test(cleaned)) {
    return "usability";
  }
  if (/\b(?:reliability|bugs?|downtime|crashes?|crash|break|breaks|outages?|uptime)\b/i.test(cleaned)) {
    return "reliability";
  }
  if (/\b(?:performance|slow|speed|lag|fast|latency)\b/i.test(cleaned)) {
    return "performance";
  }
  if (/\b(?:integrations?|api|webhooks?|connect|sync|zapier)\b/i.test(cleaned)) {
    return "integrations";
  }
  if (/\b(?:support|customer service|tickets?|helpdesk|documentation)\b/i.test(cleaned)) {
    return "support";
  }
  if (/\b(?:recommend|recommends|recommendation|love|praise|great tool|endorse|endorsement)\b/i.test(cleaned)) {
    return "recommendation_value_delivered";
  }
  if (/\bother\b/i.test(cleaned)) {
    return "other";
  }
  return "unknown";
}, z.enum(REASON_CATEGORIES));

export const switchingEvidenceSchema = z.preprocess((val) => {
  if (typeof val !== "string") return "no_clear_signal";
  const cleaned = val.trim().toLowerCase().replace(/\s+/g, " ");

  for (const pattern of NEGATION_PATTERNS) {
    if (pattern.test(cleaned)) {
      return "no_clear_signal";
    }
  }

  if (SWITCHING_EVIDENCE.includes(cleaned as SwitchingEvidence)) {
    return cleaned as SwitchingEvidence;
  }
  const snake = cleaned.replace(/[\s\/-]+/g, "_");
  if (SWITCHING_EVIDENCE.includes(snake as SwitchingEvidence)) {
    return snake as SwitchingEvidence;
  }
  if (cleaned in SWITCHING_ALIAS_MAP) {
    return SWITCHING_ALIAS_MAP[cleaned];
  }
  if (snake in SWITCHING_ALIAS_MAP) {
    return SWITCHING_ALIAS_MAP[snake];
  }
  return "no_clear_signal";
}, z.enum(SWITCHING_EVIDENCE));

export const CLASSIFY_SYSTEM = `You are reading Reddit posts that name a product. For each post say whether the post is about that product, how the writer talks about it, what specific reason drives their view, whether they are considering switching, and what they said.

1. about: "the_product" when the writer is using, evaluating, comparing, leaving or recommending it. "in_passing" when the product only appears as a link, an embed, a form hosted on it, or a name dropped with no view expressed, even when the post itself is long.
2. sentiment: "positive" when they recommend it or say it worked, "negative" when they complain, are leaving, or warn others off, and "neutral" when they only mention it, ask about it, or compare it without a verdict.
3. reasonCategory: The concrete reason behind their view:
   - "pricing_value": cost, price increases, expensive tiers, or good value for money.
   - "missing_capability": specific missing feature or limitation the product lacks.
   - "usability": UI/UX complexity, ease of use, or confusing workflows.
   - "reliability": bugs, downtime, unexpected breakages, data loss.
   - "performance": slow speed, lag, heavy resource usage, or fast responsiveness.
   - "integrations": connections to other tools, APIs, or webhooks.
   - "support": customer service quality, responsiveness, or documentation.
   - "recommendation_value_delivered": general high praise or endorsement for solving their problem.
   - "other": another concrete reason not covered above.
   - "unknown": no specific reason given or neutral mention.
4. switchingEvidence: Evidence of whether the author is considering an alternative:
   - "actively_switching": writer explicitly states they are currently migrating, cancelling, or have stopped using the product. Do not choose this if the author states they cannot switch, will not switch, are staying, or have lock-in.
   - "evaluating_alternatives": writer explicitly asks for alternatives, replacements, or competitor recommendations.
   - "dissatisfied_no_switch": writer complains or expresses frustration, but shows NO evidence that they are looking to leave or switch, OR explicitly states they cannot switch, will not switch, or are staying despite problems. (A negative comment must NEVER automatically count as switching intent).
   - "positive_recommendation": writer recommends or expresses satisfaction with the product.
   - "no_clear_signal": neutral mention or insufficient evidence. If a post has no dissatisfaction and states they are not switching, choose this.
5. explanation: 1-2 concise sentences grounded strictly in what the author actually said. Do not invent details.
6. summary: concise one-line summary of what they said.

Judge the named product only, not the rest of the post. Copy each id exactly and answer for every post you are given.`;

const verdictSchema = z.object({
  mentions: z.array(
    z.object({
      id: z.string(),
      about: z.enum(ABOUTNESS),
      sentiment: z.enum(SENTIMENTS),
      summary: z.string(),
      reasonCategory: reasonCategorySchema.default("unknown"),
      switchingEvidence: switchingEvidenceSchema.default("no_clear_signal"),
      explanation: z.string().default(""),
    }),
  ),
});

export type MentionCandidate = {
  id: string;
  title: string;
  subreddit: string;
  body: string;
};

export type Verdict = {
  about: Aboutness;
  sentiment: Sentiment;
  summary: string;
  reasonCategory: ReasonCategory;
  switchingEvidence: SwitchingEvidence;
  explanation: string;
};

/**
 * Evaluates a model's proposed switching label against the candidate post's actual title and body.
 *
 * Separates schema normalization from evidence validation:
 * 1. Posts where authors explicitly state they cannot switch, will not switch, are staying with the product,
 *    or face insurmountable lock-in / compliance constraints are never flagged as actively switching or evaluating alternatives.
 * 2. An explicit current switch (e.g. "migrating away now", "cancelled our subscription") is preserved and not suppressed
 *    by historical inability ("could not switch last year") or unrelated uses of "staying" ("staying up late", "staying at a hotel",
 *    "sister company is staying").
 * 3. Dissatisfied posts with explicit staying intent become `dissatisfied_no_switch`, while posts without dissatisfaction
 *    become `no_clear_signal`.
 */
/**
 * Detects completed historical migration statements that describe past transitions
 * without any evidence of current switching or migration away from the competitor.
 */
export function isCompletedHistoricalMigration(text: string): boolean {
  // If the text contains current transition markers ("now", "today", "currently", "this month/week"),
  // or a contrastive clause ("but now we are migrating"), it is not a completed historical event only.
  const hasCurrentTransition =
    /\b(?:currently|now|today|this\s+(?:week|month|afternoon)|finally|already\s+signed\s+up|in\s+the\s+process\s+of)\b/i.test(text) ||
    /\bbut\s+(?:now|today|currently|finally|we\s+are|we're)\s+(?:migrating|switching|moving|leaving|cancelling|canceling|dumping)\b/i.test(text);

  if (hasCurrentTransition) {
    return false;
  }

  const hasPastMigrationVerb =
    /\b(?:migrated|switched|moved|dumped|cancelled|canceled|left)\b/i.test(text) ||
    /\bused\s+to\s+(?:use|have)\b/i.test(text);

  const hasHistoricalTimeframe =
    /\b(?:\d+|two|three|four|five|several|many|a\s+couple\s+of)?\s*(?:years?|months?)\s+ago\b/i.test(text) ||
    /\blast\s+year\b/i.test(text) ||
    /\bback\s+in\s+(?:201\d|202[0-5])\b/i.test(text) ||
    /\bin\s+(?:201\d|202[0-5])\b/i.test(text) ||
    /\bpreviously\s+(?:used|had|switched|migrated)\b/i.test(text);

  return hasPastMigrationVerb && hasHistoricalTimeframe;
}

/**
 * Detects explicit current migration, cancellation, or transition to another tool.
 */
export function hasCurrentSwitchEvidence(text: string): boolean {
  if (isCompletedHistoricalMigration(text)) {
    return false;
  }

  return (
    /\b(?:we\s+are|we're|i\s+am|i'm|currently|now|already|finally|just|this\s+(?:week|month|afternoon))\s+(?:actively\s+)?(?:migrating|migrated|cancelling|canceled|cancelled|dumping|switching|moving)\b/i.test(text) ||
    /\b(?:migrating|migrated)\s+(?:away|off|over|to)\b/i.test(text) ||
    /\b(?:cancelled|canceled|cancelling|canceling)\s+(?:our|my|the)?\s*(?:[a-z0-9_-]+\s+)?(?:subscription|account|plan)\b/i.test(text) ||
    /\b(?:switching|switched)\s+(?:away|off|over|to)\s+[a-z0-9_-]+/i.test(text) ||
    /\bdumping\s+[a-z0-9_-]+/i.test(text) ||
    /\bmoved\s+(?:our|my|all|the)?\s*(?:whole\s+)?(?:workflow|team|forms?|stack|data)?\s*(?:away|over|off|to)\b/i.test(text)
  );
}

/**
 * Detects genuine queries or requests looking for or evaluating alternatives.
 */
export function hasAlternativeSearchEvidence(text: string): boolean {
  return (
    /\b(?:alternative|alternatives|replacement|replacements)\s+(?:to|for)\b/i.test(text) ||
    /\b(?:looking|searching|seeking|evaluating|considering|exploring)\s+(?:for\s+)?(?:an?\s+)?(?:alternative|alternatives|replacement|replacements|options?)\b/i.test(text) ||
    /\bany(?:one)?\s+know\s+(?:an?|any)?\s*(?:good\s+)?(?:alternative|tool\s+like|competitor)\b/i.test(text) ||
    /\brecommend(?:ations?)?\s+(?:for\s+)?(?:an?\s+)?(?:alternative|replacement)\b/i.test(text) ||
    /\b(?:are\s+there|is\s+there)\s+any\s+(?:good\s+)?(?:form\s+tools?|tools?|apps?|competitors?)\s+like\b/i.test(text) ||
    /\bneed\s+(?:an?\s+)?alternative\s+to\b/i.test(text)
  );
}

/**
 * Detects statements indicating staying intent, inability to switch, or vendor/compliance lock-in.
 */
export function hasStayingOrLockInEvidence(text: string, competitor?: string): boolean {
  const escapedCompetitor = competitor ? competitor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
  const competitorStaying = escapedCompetitor
    ? new RegExp(`\\b(?:staying\\s+(?:with|on)|not\\s+leaving)\\s+${escapedCompetitor}\\b`, "i").test(text)
    : false;

  return (
    competitorStaying ||
    /\b(?:cannot|can't|cant|won't|wont|will\s+not|never|could\s+not|couldn't)\s+(?:switch|leave|migrate|move)\b/i.test(text) ||
    /\bnot\s+(?:actively\s+)?(?:switching|leaving|migrating|moving)\b/i.test(text) ||
    /\bno\s+(?:switch|plans?\s+to\s+switch|intention\s+to\s+switch|way\s+to\s+switch)\b/i.test(text) ||
    /\bnot\s+(?:looking\s+for|seeking|evaluating|considering)\s+(?:alternatives?|replacements?)\b/i.test(text) ||
    /\btoo\s+(?:many|much)\s+(?:integrations?|dependencies|complexity)\s+to\s+(?:ever\s+)?(?:leave|switch)\b/i.test(text) ||
    /\b(?:compliance|legal|security|enterprise)\s+(?:team\s+)?approved\s+.*?\b(?:cannot|can't|unable\s+to)\s+switch\b/i.test(text) ||
    /\b(?:vendor|api|data|platform|integration)\s+lock-?in\b/i.test(text) ||
    /\b(?:cannot|can't|unable\s+to)\s+(?:leave|switch)\s+because\b/i.test(text) ||
    /\bstaying\s+despite\b/i.test(text) ||
    /\b(?:decided|chosen|plan|planning|going)\s+to\s+stay\b/i.test(text) ||
    /\bstaying\s+(?:with|on)\s+[a-z0-9_-]+/i.test(text) ||
    /\b(?:we're|we\s+are|i'm|i\s+am)\s+staying\b(?!\s+(?:at\b|up\b|in\s+touch\b|tuned\b))/i.test(text)
  );
}

/**
 * Evaluates whether staying or lock-in applies to the author currently,
 * excluding historical inabilities, statements about other entities, or unrelated uses of "staying".
 */
export function hasEffectiveStaying(text: string, competitor?: string): boolean {
  if (!hasStayingOrLockInEvidence(text, competitor)) {
    return false;
  }

  // 1. Is inability historical and contrasted with a current transition?
  const isHistoricalInabilityOnly =
    (/\b(?:could\s+not|couldn't|was\s+not\s+able\s+to|were\s+not\s+able\s+to|used\s+to\s+not)\s+switch\b/i.test(text) ||
     /\b(?:last\s+year|previously|in\s+the\s+past|before|initially)\b.*?\b(?:cannot|can't|could\s+not|couldn't|didn't)\s+switch\b/i.test(text)) &&
    /\bbut\s+(?:now|currently|today|finally|we\s+are|we're)\b.*?\b(?:migrat|switch|leav|cancel|dump)/i.test(text);

  if (isHistoricalInabilityOnly) {
    return false;
  }

  // 2. Is the staying statement about another team or company while the author migrates?
  const isOtherTeamStaying =
    /\b(?:partner|client|sister\s+company|other\s+team|parent\s+company)\s+(?:is\s+)?staying\b/i.test(text) &&
    /\b(?:we|our\s+team|i)\s+(?:are|am|'re|'m)?\s*(?:migrating|switching|dumping|moving|leaving|cancelling|canceling)\b/i.test(text);

  if (isOtherTeamStaying) {
    return false;
  }

  // 3. Is the word "staying" used in an unrelated colloquial sense?
  const isUnrelatedStaying =
    /\bstaying\s+(?:up\s+late|up|at\s+a\s+hotel|at\b|in\s+touch\b|tuned\b)/i.test(text) &&
    !/\bstaying\s+(?:with|on)\s+[a-z0-9_-]+/i.test(text);

  if (isUnrelatedStaying) {
    return false;
  }

  return true;
}

/**
 * Detects whether the candidate text or proposed sentiment indicates dissatisfaction/complaint.
 */
export function isDissatisfiedContent(text: string, sentiment?: Sentiment): boolean {
  if (sentiment === "negative") {
    return true;
  }

  return /\b(?:frustrat|hate|terrible|awful|horrible|broken|outage|downtime|bug|bugs|issue|issues|annoy|expensive|extortion|ridiculous|fail|fails|failed|failing|slow|bloated|delay|unhappy|disappointed|angry|mad|sucks|worst)\b/i.test(text);
}

/**
 * Evaluates a model's proposed switching label against the candidate post's actual title and body.
 *
 * Bidirectional guard:
 * 1. Explicit current migration, cancellation, or transition overrides incorrect non-switching
 *    labels (dissatisfied_no_switch, no_clear_signal) to actively_switching.
 * 2. Genuine alternative searches override incorrect neutral labels to evaluating_alternatives.
 * 3. Statements indicating staying intent, inability to switch, or lock-in block switching labels
 *    and map to dissatisfied_no_switch (if dissatisfaction is present) or no_clear_signal.
 * 4. Completed historical migrations without a current transition do not become actively_switching.
 * 5. Negative sentiment alone does not imply switching intent.
 */
export function guardSwitchingEvidence(
  candidate: { title: string; body: string },
  proposed: {
    sentiment: Sentiment;
    reasonCategory: ReasonCategory;
    switchingEvidence: SwitchingEvidence;
  },
  competitor?: string,
): SwitchingEvidence {
  const fullText = `${candidate.title} ${candidate.body}`;
  const proposedLabel = proposed.switchingEvidence;

  const effectiveStaying = hasEffectiveStaying(fullText, competitor);
  const currentSwitch = hasCurrentSwitchEvidence(fullText);
  const altSearch = hasAlternativeSearchEvidence(fullText);
  const dissatisfied = isDissatisfiedContent(fullText, proposed.sentiment);

  // 1. Explicit staying / inability / lock-in takes precedence over switching
  if (effectiveStaying) {
    return dissatisfied ? "dissatisfied_no_switch" : "no_clear_signal";
  }

  // 2. Explicit current switching evidence overrides model false negatives
  if (currentSwitch) {
    return "actively_switching";
  }

  // 3. Genuine alternative search queries override model false negatives
  if (altSearch) {
    return "evaluating_alternatives";
  }

  // 4. When text contains NO current switching or alternative evaluation:
  // If the model proposed actively_switching or evaluating_alternatives, that was a false positive.
  if (proposedLabel === "actively_switching" || proposedLabel === "evaluating_alternatives") {
    return dissatisfied ? "dissatisfied_no_switch" : "no_clear_signal";
  }

  // 5. For non-switching labels (dissatisfied_no_switch, positive_recommendation, no_clear_signal):
  if (proposedLabel === "dissatisfied_no_switch") {
    // Preserve dissatisfied_no_switch only if there is genuine dissatisfaction
    return dissatisfied ? "dissatisfied_no_switch" : "no_clear_signal";
  }

  return proposedLabel;
}

function describe(item: MentionCandidate): string {
  return [
    `id: ${item.id}`,
    `subreddit: r/${item.subreddit}`,
    `title: ${item.title}`,
    `text: ${item.body.slice(0, 3000)}`,
  ].join("\n");
}

/**
 * One call for one competitor's posts. An answer about a post we did not send,
 * or a second answer about the same post, is dropped rather than stored.
 */
export async function classifyMentions(
  projectId: string,
  competitor: string,
  items: MentionCandidate[],
): Promise<Map<string, Verdict>> {
  const out = new Map<string, Verdict>();
  if (items.length === 0) {
    return out;
  }
  const result = await generateStructured({
    purpose: "competitors",
    projectId,
    schema: verdictSchema,
    system: CLASSIFY_SYSTEM,
    prompt: [
      `Product being talked about: ${competitor}`,
      "",
      "Posts:",
      items.map(describe).join("\n---\n"),
    ].join("\n"),
  });
  const known = new Set(items.map((item) => item.id));
  const candidateMap = new Map(items.map((item) => [item.id, item]));
  for (const mention of result.mentions) {
    if (known.has(mention.id) && !out.has(mention.id)) {
      const candidate = candidateMap.get(mention.id);
      const guardedSwitching = candidate
        ? guardSwitchingEvidence(
            candidate,
            {
              sentiment: mention.sentiment,
              reasonCategory: mention.reasonCategory,
              switchingEvidence: mention.switchingEvidence,
            },
            competitor,
          )
        : mention.switchingEvidence;

      out.set(mention.id, {
        about: mention.about,
        sentiment: mention.sentiment,
        summary: mention.summary.trim(),
        reasonCategory: mention.reasonCategory,
        switchingEvidence: guardedSwitching,
        explanation: mention.explanation.trim() || mention.summary.trim(),
      });
    }
  }
  return out;
}
