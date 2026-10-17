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

export const reasonCategorySchema = z.preprocess((val) => {
  if (typeof val !== "string") return "unknown";
  const raw = val.trim().toLowerCase();
  const normalized = raw.replace(/[\s\/-]+/g, "_");
  if (REASON_CATEGORIES.includes(normalized as ReasonCategory)) return normalized;
  if (normalized.includes("pricing") || normalized.includes("price") || normalized.includes("cost") || normalized.includes("tier")) return "pricing_value";
  if (normalized.includes("missing") || normalized.includes("feature") || normalized.includes("capability") || normalized.includes("limitation")) return "missing_capability";
  if (normalized.includes("usab") || normalized.includes("ux") || normalized.includes("ui") || normalized.includes("complex") || normalized.includes("confus") || normalized.includes("ease")) return "usability";
  if (normalized.includes("reliab") || normalized.includes("bug") || normalized.includes("down") || normalized.includes("crash") || normalized.includes("break")) return "reliability";
  if (normalized.includes("perform") || normalized.includes("slow") || normalized.includes("speed") || normalized.includes("lag") || normalized.includes("fast")) return "performance";
  if (normalized.includes("integrat") || normalized.includes("api") || normalized.includes("webhook") || normalized.includes("connect")) return "integrations";
  if (normalized.includes("support") || normalized.includes("service") || normalized.includes("ticket") || normalized.includes("help") || normalized.includes("doc")) return "support";
  if (normalized.includes("recommend") || normalized.includes("value") || normalized.includes("love") || normalized.includes("praise") || normalized.includes("great") || normalized.includes("good")) return "recommendation_value_delivered";
  if (normalized.includes("other")) return "other";
  return "unknown";
}, z.enum(REASON_CATEGORIES));

export const switchingEvidenceSchema = z.preprocess((val) => {
  if (typeof val !== "string") return "no_clear_signal";
  const raw = val.trim().toLowerCase();
  const normalized = raw.replace(/[\s\/-]+/g, "_");
  if (SWITCHING_EVIDENCE.includes(normalized as SwitchingEvidence)) return normalized;
  if (normalized.includes("actively_switch") || normalized.includes("switching") || normalized.includes("left") || normalized.includes("cancelled") || normalized.includes("migrat")) return "actively_switching";
  if (normalized.includes("evaluating") || normalized.includes("alternative") || normalized.includes("looking_for") || normalized.includes("replac") || normalized.includes("considering")) return "evaluating_alternatives";
  if (normalized.includes("dissatisfied") || normalized.includes("complaint") || normalized.includes("frustrat") || normalized.includes("annoy") || normalized.includes("hate") || normalized.includes("bad")) return "dissatisfied_no_switch";
  if (normalized.includes("positive") || normalized.includes("recommend") || normalized.includes("happy") || normalized.includes("satisf")) return "positive_recommendation";
  if (normalized.includes("no_clear") || normalized.includes("none") || normalized.includes("unknown") || normalized.includes("neutral")) return "no_clear_signal";
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
   - "actively_switching": writer explicitly states they are currently migrating, cancelling, or have stopped using the product.
   - "evaluating_alternatives": writer explicitly asks for alternatives, replacements, or competitor recommendations.
   - "dissatisfied_no_switch": writer complains or expresses frustration, but shows NO evidence that they are looking to leave or switch. (A negative comment must NEVER automatically count as switching intent).
   - "positive_recommendation": writer recommends or expresses satisfaction with the product.
   - "no_clear_signal": neutral mention or insufficient evidence.
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
  for (const mention of result.mentions) {
    if (known.has(mention.id) && !out.has(mention.id)) {
      out.set(mention.id, {
        about: mention.about,
        sentiment: mention.sentiment,
        summary: mention.summary.trim(),
        reasonCategory: mention.reasonCategory,
        switchingEvidence: mention.switchingEvidence,
        explanation: mention.explanation.trim() || mention.summary.trim(),
      });
    }
  }
  return out;
}
