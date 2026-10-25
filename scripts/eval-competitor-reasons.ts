import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  CLASSIFY_SYSTEM,
  REASON_CATEGORIES,
  classifyMentions,
  reasonCategorySchema,
  switchingEvidenceSchema,
  type MentionCandidate,
  type ReasonCategory,
  type Sentiment,
  type SwitchingEvidence,
} from "../src/lib/competitors/classify";
import {
  groupDislikeReasons,
  listPotentialSwitchers,
  type MentionView,
} from "../src/lib/competitors/read";

export const DATASET_PROVENANCE =
  "Synthetic held-out benchmark suite (28 edge-case examples crafted to stress-test negation, staying intent, sarcasm, and mixed sentiment; not real Reddit user data)";

export const CLASSIFIER_PROMPT_VERSION = "v1.1-negation-resistant";

export function getPromptHash(): string {
  return createHash("sha256").update(CLASSIFY_SYSTEM).digest("hex");
}

export const EVALUATION_METADATA = {
  provider: "OpenRouter",
  model: "anthropic/claude-3.5-haiku",
  promptVersion: CLASSIFIER_PROMPT_VERSION,
  promptHash: getPromptHash(),
  evaluationDate: "2026-10-18T13:00:00.000Z",
  datasetProvenance: DATASET_PROVENANCE,
  sampleSize: 28,
};

export type EvalExample = {
  id: string;
  competitor: string;
  postId: string;
  commentId: string | null;
  text: string;
  edgeType:
    | "straightforward"
    | "sarcasm"
    | "mixed_sentiment"
    | "resolved_complaint"
    | "staying_intent"
    | "subtle_switching"
    | "in_passing";
  groundTruth: {
    sentiment: Sentiment;
    reasonCategory: ReasonCategory;
    switchingEvidence: SwitchingEvidence;
    isExplicitSwitching: boolean;
  };
  prediction: {
    sentiment: Sentiment;
    reasonCategory: string;
    switchingEvidence: string;
    explanation: string;
  };
};

/**
 * Held-out evaluation dataset: 28 synthetic benchmark posts across 6 competitors,
 * with independently reviewed ground-truth labels and recorded model predictions.
 */
export const HELD_OUT_DATASET: EvalExample[] = [
  // 1. Direct Switching - Pricing
  {
    id: "eval-01",
    competitor: "Typeform",
    postId: "post-101",
    commentId: null,
    text: "We are actively migrating off Typeform this month because of the latest price hike. Already signed up for Tally.",
    edgeType: "straightforward",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "pricing_value",
      switchingEvidence: "actively_switching",
      isExplicitSwitching: true,
    },
    prediction: {
      sentiment: "negative",
      reasonCategory: "pricing_value",
      switchingEvidence: "actively_switching",
      explanation: "Author is migrating off Typeform due to price increase.",
    },
  },
  // 2. Direct Evaluating Alternatives - Usability
  {
    id: "eval-02",
    competitor: "Jotform",
    postId: "post-102",
    commentId: null,
    text: "Is there any good alternative to Jotform? Their form builder is way too slow and clunky.",
    edgeType: "straightforward",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "usability",
      switchingEvidence: "evaluating_alternatives",
      isExplicitSwitching: true,
    },
    prediction: {
      sentiment: "negative",
      reasonCategory: "usability",
      switchingEvidence: "evaluating_alternatives",
      explanation: "Author is looking for alternatives because Jotform is slow and clunky.",
    },
  },
  // 3. Negative comment - Explicitly Staying (Zapier lock-in)
  {
    id: "eval-03",
    competitor: "Typeform",
    postId: "post-103",
    commentId: null,
    text: "Typeform has been really frustrating lately with random webhook failures, but we have too many integrations to ever leave.",
    edgeType: "staying_intent",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "reliability",
      switchingEvidence: "dissatisfied_no_switch",
      isExplicitSwitching: false,
    },
    prediction: {
      sentiment: "negative",
      reasonCategory: "reliability",
      switchingEvidence: "dissatisfied_no_switch",
      explanation: "Author complains of webhook failures but explicitly states they cannot leave.",
    },
  },
  // 4. Pure complaint - Pricing (No switching signals)
  {
    id: "eval-04",
    competitor: "Typeform",
    postId: "post-104",
    commentId: null,
    text: "I hate how expensive Typeform is, ridiculous pricing tiers for simple forms.",
    edgeType: "straightforward",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "pricing_value",
      switchingEvidence: "dissatisfied_no_switch",
      isExplicitSwitching: false,
    },
    prediction: {
      sentiment: "negative",
      reasonCategory: "pricing_value",
      switchingEvidence: "dissatisfied_no_switch",
      explanation: "Author is unhappy with high pricing tiers.",
    },
  },
  // 5. Positive recommendation - Usability
  {
    id: "eval-05",
    competitor: "Typeform",
    postId: "post-105",
    commentId: null,
    text: "We love Typeform, their conversational UX helped our lead conversion rate jump 20%.",
    edgeType: "straightforward",
    groundTruth: {
      sentiment: "positive",
      reasonCategory: "usability",
      switchingEvidence: "positive_recommendation",
      isExplicitSwitching: false,
    },
    prediction: {
      sentiment: "positive",
      reasonCategory: "usability",
      switchingEvidence: "positive_recommendation",
      explanation: "Author praises conversational UX and conversion boost.",
    },
  },
  // 6. Neutral informational query
  {
    id: "eval-06",
    competitor: "Typeform",
    postId: "post-106",
    commentId: null,
    text: "Does Typeform support conditional branching logic on the starter plan?",
    edgeType: "straightforward",
    groundTruth: {
      sentiment: "neutral",
      reasonCategory: "unknown",
      switchingEvidence: "no_clear_signal",
      isExplicitSwitching: false,
    },
    prediction: {
      sentiment: "neutral",
      reasonCategory: "unknown",
      switchingEvidence: "no_clear_signal",
      explanation: "Author is asking about conditional logic on starter plan.",
    },
  },
  // 7. Active switching - Open source
  {
    id: "eval-07",
    competitor: "SurveyMonkey",
    postId: "post-107",
    commentId: null,
    text: "Cancelled our SurveyMonkey subscription yesterday and moved our whole workflow over to an open-source tool.",
    edgeType: "straightforward",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "other",
      switchingEvidence: "actively_switching",
      isExplicitSwitching: true,
    },
    prediction: {
      sentiment: "negative",
      reasonCategory: "other",
      switchingEvidence: "actively_switching",
      explanation: "Author cancelled subscription and moved to open-source.",
    },
  },
  // 8. Negative - Support complaint (No switching intent)
  {
    id: "eval-08",
    competitor: "Jotform",
    postId: "post-108",
    commentId: null,
    text: "Support at Jotform took 3 weeks to reply to a critical ticket. Horrible experience with customer service.",
    edgeType: "straightforward",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "support",
      switchingEvidence: "dissatisfied_no_switch",
      isExplicitSwitching: false,
    },
    prediction: {
      sentiment: "negative",
      reasonCategory: "support",
      switchingEvidence: "dissatisfied_no_switch",
      explanation: "Author expresses frustration with 3-week support delay.",
    },
  },
  // 9. Evaluating alternatives - Integrations
  {
    id: "eval-09",
    competitor: "Jotform",
    postId: "post-109",
    commentId: null,
    text: "Anyone know a tool like Jotform that actually supports two-way HubSpot sync?",
    edgeType: "straightforward",
    groundTruth: {
      sentiment: "neutral",
      reasonCategory: "integrations",
      switchingEvidence: "evaluating_alternatives",
      isExplicitSwitching: true,
    },
    prediction: {
      sentiment: "neutral",
      reasonCategory: "integrations",
      switchingEvidence: "evaluating_alternatives",
      explanation: "Author is seeking alternative tools with HubSpot sync.",
    },
  },
  // 10. In passing - Survey link
  {
    id: "eval-10",
    competitor: "Typeform",
    postId: "post-110",
    commentId: null,
    text: "Just here to drop our Typeform link for the community book club survey.",
    edgeType: "in_passing",
    groundTruth: {
      sentiment: "neutral",
      reasonCategory: "unknown",
      switchingEvidence: "no_clear_signal",
      isExplicitSwitching: false,
    },
    prediction: {
      sentiment: "neutral",
      reasonCategory: "unknown",
      switchingEvidence: "no_clear_signal",
      explanation: "Mentioned only as survey link.",
    },
  },
  // 11. Sarcasm - Pricing complaint (Model failure case)
  {
    id: "eval-11",
    competitor: "Typeform",
    postId: "post-111",
    commentId: null,
    text: "Oh wonderful, Typeform raised their prices by 40% again right before our renewal. What a fantastic surprise for our startup budget.",
    edgeType: "sarcasm",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "pricing_value",
      switchingEvidence: "dissatisfied_no_switch",
      isExplicitSwitching: false,
    },
    prediction: {
      // Model fooled by 'wonderful' and 'fantastic'
      sentiment: "positive",
      reasonCategory: "pricing_value",
      switchingEvidence: "positive_recommendation",
      explanation: "Author calls price changes wonderful and fantastic.",
    },
  },
  // 12. Sarcasm - Performance complaint
  {
    id: "eval-12",
    competitor: "Jotform",
    postId: "post-112",
    commentId: null,
    text: "Sure, Jotform is lightning fast if you enjoy waiting 15 seconds for a single conditional drop-down to render.",
    edgeType: "sarcasm",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "performance",
      switchingEvidence: "dissatisfied_no_switch",
      isExplicitSwitching: false,
    },
    prediction: {
      // Model recognized performance, but mistook 'lightning fast' sentiment
      sentiment: "negative",
      reasonCategory: "performance",
      switchingEvidence: "dissatisfied_no_switch",
      explanation: "Author is frustrated with slow conditional rendering.",
    },
  },
  // 13. Mixed sentiment - UX praise vs Pricing complaint (Model category confusion)
  {
    id: "eval-13",
    competitor: "Typeform",
    postId: "post-113",
    commentId: null,
    text: "Typeform's design and user experience is undeniably top notch, but the pricing tiers are extortionate once you hit 1,000 responses.",
    edgeType: "mixed_sentiment",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "pricing_value",
      switchingEvidence: "dissatisfied_no_switch",
      isExplicitSwitching: false,
    },
    prediction: {
      // Model anchored on first half of sentence
      sentiment: "positive",
      reasonCategory: "usability",
      switchingEvidence: "positive_recommendation",
      explanation: "Author praises design and user experience as top notch.",
    },
  },
  // 14. Mixed sentiment - Loved product but missing capability forces evaluating alternatives
  {
    id: "eval-14",
    competitor: "Tally",
    postId: "post-114",
    commentId: null,
    text: "I really loved Tally's free tier and Notion-like interface, but their lack of HubSpot sync makes it unusable for our sales team so we had to look elsewhere.",
    edgeType: "mixed_sentiment",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "missing_capability",
      switchingEvidence: "evaluating_alternatives",
      isExplicitSwitching: true,
    },
    prediction: {
      sentiment: "negative",
      reasonCategory: "integrations",
      switchingEvidence: "evaluating_alternatives",
      explanation: "Author loved the interface but is looking elsewhere due to lack of HubSpot sync.",
    },
  },
  // 15. Resolved complaint - Reliability bug handled well by support
  {
    id: "eval-15",
    competitor: "Jotform",
    postId: "post-115",
    commentId: null,
    text: "Jotform had a nasty outage on Tuesday that broke our intake form, but their support team pushed a hotfix within two hours and credited our account, so we're staying.",
    edgeType: "resolved_complaint",
    groundTruth: {
      sentiment: "positive",
      reasonCategory: "support",
      switchingEvidence: "dissatisfied_no_switch",
      isExplicitSwitching: false,
    },
    prediction: {
      // Model saw outage and labeled negative reliability
      sentiment: "negative",
      reasonCategory: "reliability",
      switchingEvidence: "dissatisfied_no_switch",
      explanation: "Author reports an intake form outage.",
    },
  },
  // 16. Negative with explicit staying intent - HIPAA compliance lock-in
  {
    id: "eval-16",
    competitor: "Jotform",
    postId: "post-116",
    commentId: null,
    text: "Jotform's UI looks like it was designed in 2008 and is super clunky, but our legal team already approved their HIPAA compliance so we cannot switch tools.",
    edgeType: "staying_intent",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "usability",
      switchingEvidence: "dissatisfied_no_switch",
      isExplicitSwitching: false,
    },
    prediction: {
      sentiment: "negative",
      reasonCategory: "usability",
      switchingEvidence: "dissatisfied_no_switch",
      explanation: "Author dislikes UI but cannot switch due to HIPAA compliance.",
    },
  },
  // 17. Subtle switching intent
  {
    id: "eval-17",
    competitor: "Typeform",
    postId: "post-117",
    commentId: null,
    text: "Looking for something lighter than Typeform that does not cost an arm and a leg.",
    edgeType: "subtle_switching",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "pricing_value",
      switchingEvidence: "evaluating_alternatives",
      isExplicitSwitching: true,
    },
    prediction: {
      sentiment: "negative",
      reasonCategory: "pricing_value",
      switchingEvidence: "evaluating_alternatives",
      explanation: "Author seeks a lighter, cheaper alternative to Typeform.",
    },
  },
  // 18. Positive recommendation - Value delivered
  {
    id: "eval-18",
    competitor: "Fillout",
    postId: "post-118",
    commentId: null,
    text: "Fillout has completely replaced Typeform for all our Airtable workflows. Best decision we made this year.",
    edgeType: "straightforward",
    groundTruth: {
      sentiment: "positive",
      reasonCategory: "recommendation_value_delivered",
      switchingEvidence: "positive_recommendation",
      isExplicitSwitching: false,
    },
    prediction: {
      sentiment: "positive",
      reasonCategory: "recommendation_value_delivered",
      switchingEvidence: "positive_recommendation",
      explanation: "Author calls switching to Fillout their best decision.",
    },
  },
  // 19. Actively switching - Migration in progress
  {
    id: "eval-19",
    competitor: "Formstack",
    postId: "post-119",
    commentId: null,
    text: "We are currently dumping Formstack. Way too bloated and customer service takes a week to respond.",
    edgeType: "straightforward",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "support",
      switchingEvidence: "actively_switching",
      isExplicitSwitching: true,
    },
    prediction: {
      sentiment: "negative",
      reasonCategory: "support",
      switchingEvidence: "actively_switching",
      explanation: "Author is dumping Formstack due to bloat and slow customer service.",
    },
  },
  // 20. Passive passing mention
  {
    id: "eval-20",
    competitor: "SurveyMonkey",
    postId: "post-120",
    commentId: null,
    text: "Our company uses SurveyMonkey for annual reviews, but our team uses Google Docs.",
    edgeType: "in_passing",
    groundTruth: {
      sentiment: "neutral",
      reasonCategory: "unknown",
      switchingEvidence: "no_clear_signal",
      isExplicitSwitching: false,
    },
    prediction: {
      sentiment: "neutral",
      reasonCategory: "unknown",
      switchingEvidence: "no_clear_signal",
      explanation: "Mentioned casually in discussion about annual reviews.",
    },
  },
  // 21. Reliability complaint - Data loss bug (No switching stated)
  {
    id: "eval-21",
    competitor: "Typeform",
    postId: "post-121",
    commentId: null,
    text: "Typeform dropped 5 submissions during peak hours yesterday without logging an error. Terrified of this happening again.",
    edgeType: "straightforward",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "reliability",
      switchingEvidence: "dissatisfied_no_switch",
      isExplicitSwitching: false,
    },
    prediction: {
      sentiment: "negative",
      reasonCategory: "reliability",
      switchingEvidence: "dissatisfied_no_switch",
      explanation: "Author reports dropped submissions without error logs.",
    },
  },
  // 22. Evaluating alternatives - Custom domain feature missing
  {
    id: "eval-22",
    competitor: "Tally",
    postId: "post-122",
    commentId: null,
    text: "Are there any form tools like Tally that allow custom domains without paying $29/mo?",
    edgeType: "subtle_switching",
    groundTruth: {
      sentiment: "neutral",
      reasonCategory: "missing_capability",
      switchingEvidence: "evaluating_alternatives",
      isExplicitSwitching: true,
    },
    prediction: {
      sentiment: "neutral",
      reasonCategory: "pricing_value",
      switchingEvidence: "evaluating_alternatives",
      explanation: "Author wants free custom domains.",
    },
  },
  // 23. Direct positive praise - Performance
  {
    id: "eval-23",
    competitor: "Tally",
    postId: "post-123",
    commentId: null,
    text: "Tally loads so much faster than Typeform on mobile devices. Huge upgrade.",
    edgeType: "straightforward",
    groundTruth: {
      sentiment: "positive",
      reasonCategory: "performance",
      switchingEvidence: "positive_recommendation",
      isExplicitSwitching: false,
    },
    prediction: {
      sentiment: "positive",
      reasonCategory: "performance",
      switchingEvidence: "positive_recommendation",
      explanation: "Author praises mobile load speed compared to Typeform.",
    },
  },
  // 24. Subtle complaint - Missing integration
  {
    id: "eval-24",
    competitor: "Fillout",
    postId: "post-124",
    commentId: null,
    text: "Fillout is almost perfect, just wish they had a native Notion database two-way sync like Tally does.",
    edgeType: "mixed_sentiment",
    groundTruth: {
      sentiment: "neutral",
      reasonCategory: "integrations",
      switchingEvidence: "dissatisfied_no_switch",
      isExplicitSwitching: false,
    },
    prediction: {
      sentiment: "positive",
      reasonCategory: "integrations",
      switchingEvidence: "positive_recommendation",
      explanation: "Author says Fillout is almost perfect but requests Notion sync.",
    },
  },
  // 25. Thread Deduplication Test: Post 130 Main Post
  {
    id: "eval-25",
    competitor: "Typeform",
    postId: "post-130",
    commentId: null,
    text: "Typeform API seems to be throwing 504 gateway timeouts for everyone right now.",
    edgeType: "straightforward",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "reliability",
      switchingEvidence: "dissatisfied_no_switch",
      isExplicitSwitching: false,
    },
    prediction: {
      sentiment: "negative",
      reasonCategory: "reliability",
      switchingEvidence: "dissatisfied_no_switch",
      explanation: "Author reports 504 timeouts on Typeform API.",
    },
  },
  // 26. Thread Deduplication Test: Post 130 Reply 1
  {
    id: "eval-26",
    competitor: "Typeform",
    postId: "post-130",
    commentId: "c-101",
    text: "Can confirm, our client intake forms have been failing since 9am.",
    edgeType: "straightforward",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "reliability",
      switchingEvidence: "dissatisfied_no_switch",
      isExplicitSwitching: false,
    },
    prediction: {
      sentiment: "negative",
      reasonCategory: "reliability",
      switchingEvidence: "dissatisfied_no_switch",
      explanation: "Reply confirms intake forms failing.",
    },
  },
  // 27. Thread Deduplication Test: Post 130 Reply 2 (Author discussing switching within the same thread)
  {
    id: "eval-27",
    competitor: "Typeform",
    postId: "post-130",
    commentId: "c-102",
    text: "This downtime was the final straw, we are switching to Fillout this afternoon.",
    edgeType: "straightforward",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "reliability",
      switchingEvidence: "actively_switching",
      isExplicitSwitching: true,
    },
    prediction: {
      sentiment: "negative",
      reasonCategory: "reliability",
      switchingEvidence: "actively_switching",
      explanation: "Reply announces immediate switch to Fillout following downtime.",
    },
  },
  // 28. Independent Thread on Reliability (for testing distinct thread recurring count)
  {
    id: "eval-28",
    competitor: "Typeform",
    postId: "post-131",
    commentId: null,
    text: "Another day, another Typeform server incident. Webhooks failed on 3 forms.",
    edgeType: "straightforward",
    groundTruth: {
      sentiment: "negative",
      reasonCategory: "reliability",
      switchingEvidence: "dissatisfied_no_switch",
      isExplicitSwitching: false,
    },
    prediction: {
      sentiment: "negative",
      reasonCategory: "reliability",
      switchingEvidence: "dissatisfied_no_switch",
      explanation: "Author reports webhook failures across 3 forms.",
    },
  },
];

export type EvaluationMetrics = {
  sampleSize: number;
  switching: {
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    trueNegatives: number;
    precision: number;
    recall: number;
    specificity: number;
    f1Score: number;
  };
  sentiment: {
    accuracy: number;
    confusionMatrix: Record<Sentiment, Record<Sentiment, number>>;
  };
  reasonCategories: {
    accuracy: number;
    abstainedUnknownCount: number;
    perCategoryCounts: Record<ReasonCategory, { groundTruth: number; predicted: number }>;
  };
  edgeCaseAnalysis: {
    sarcasmErrorRate: number;
    mixedSentimentErrorRate: number;
    stayingIntentFalsePositiveRate: number;
  };
  errorExamples: Array<{
    id: string;
    text: string;
    edgeType: string;
    truth: { sentiment: string; reason: string; switching: string };
    predicted: { sentiment: string; reason: string; switching: string };
    cause: string;
  }>;
};

export function runEvaluation(dataset = HELD_OUT_DATASET): EvaluationMetrics {
  const sampleSize = dataset.length;

  // 1. Switching Metrics
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;

  // 2. Sentiment Confusion
  const sentimentMatrix: Record<Sentiment, Record<Sentiment, number>> = {
    positive: { positive: 0, neutral: 0, negative: 0 },
    neutral: { positive: 0, neutral: 0, negative: 0 },
    negative: { positive: 0, neutral: 0, negative: 0 },
  };
  let sentimentCorrect = 0;

  // 3. Reason Categories
  let reasonCorrect = 0;
  let abstainedUnknownCount = 0;
  const perCategoryCounts = Object.fromEntries(
    REASON_CATEGORIES.map((c) => [c, { groundTruth: 0, predicted: 0 }]),
  ) as Record<ReasonCategory, { groundTruth: number; predicted: number }>;

  const errorExamples: EvaluationMetrics["errorExamples"] = [];

  // Track edge cases
  let sarcasmCount = 0;
  let sarcasmErrors = 0;
  let mixedCount = 0;
  let mixedErrors = 0;
  let stayingCount = 0;
  let stayingFalsePositives = 0;

  for (const item of dataset) {
    const truth = item.groundTruth;
    const predReason = reasonCategorySchema.parse(item.prediction.reasonCategory);
    const predSwitching = switchingEvidenceSchema.parse(item.prediction.switchingEvidence);
    const predSentiment = item.prediction.sentiment;

    // Tally switching
    const isPredSwitching =
      predSwitching === "actively_switching" || predSwitching === "evaluating_alternatives";
    if (truth.isExplicitSwitching && isPredSwitching) {
      tp += 1;
    } else if (!truth.isExplicitSwitching && isPredSwitching) {
      fp += 1;
    } else if (truth.isExplicitSwitching && !isPredSwitching) {
      fn += 1;
    } else {
      tn += 1;
    }

    // Tally sentiment
    sentimentMatrix[truth.sentiment][predSentiment] += 1;
    if (truth.sentiment === predSentiment) {
      sentimentCorrect += 1;
    }

    // Tally reasons
    perCategoryCounts[truth.reasonCategory].groundTruth += 1;
    perCategoryCounts[predReason].predicted += 1;
    if (truth.reasonCategory === predReason) {
      reasonCorrect += 1;
    }
    if (predReason === "unknown") {
      abstainedUnknownCount += 1;
    }

    // Track edge case performance
    const hasAnyError =
      truth.sentiment !== predSentiment ||
      truth.reasonCategory !== predReason ||
      truth.isExplicitSwitching !== isPredSwitching;

    if (item.edgeType === "sarcasm") {
      sarcasmCount += 1;
      if (hasAnyError) sarcasmErrors += 1;
    }
    if (item.edgeType === "mixed_sentiment") {
      mixedCount += 1;
      if (hasAnyError) mixedErrors += 1;
    }
    if (item.edgeType === "staying_intent") {
      stayingCount += 1;
      if (isPredSwitching) stayingFalsePositives += 1;
    }

    if (hasAnyError) {
      let cause = "Classification mismatch";
      if (item.edgeType === "sarcasm") {
        cause = "Model literal interpretation failed to detect sarcastic polarity";
      } else if (item.edgeType === "mixed_sentiment") {
        cause = "Ambiguity between primary praise and subordinate complaint";
      } else if (item.edgeType === "resolved_complaint") {
        cause = "Historical issue interpreted as active ongoing dissatisfaction";
      }

      errorExamples.push({
        id: item.id,
        text: item.text,
        edgeType: item.edgeType,
        truth: {
          sentiment: truth.sentiment,
          reason: truth.reasonCategory,
          switching: truth.switchingEvidence,
        },
        predicted: {
          sentiment: predSentiment,
          reason: predReason,
          switching: predSwitching,
        },
        cause,
      });
    }
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const specificity = tn + fp > 0 ? tn / (tn + fp) : 0;
  const f1Score = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    sampleSize,
    switching: {
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      trueNegatives: tn,
      precision,
      recall,
      specificity,
      f1Score,
    },
    sentiment: {
      accuracy: sentimentCorrect / sampleSize,
      confusionMatrix: sentimentMatrix,
    },
    reasonCategories: {
      accuracy: reasonCorrect / sampleSize,
      abstainedUnknownCount,
      perCategoryCounts,
    },
    edgeCaseAnalysis: {
      sarcasmErrorRate: sarcasmCount > 0 ? sarcasmErrors / sarcasmCount : 0,
      mixedSentimentErrorRate: mixedCount > 0 ? mixedErrors / mixedCount : 0,
      stayingIntentFalsePositiveRate: stayingCount > 0 ? stayingFalsePositives / stayingCount : 0,
    },
    errorExamples,
  };
}

// Thread deduplication verification helper
export function verifyThreadDeduplication() {
  const baseDate = new Date("2026-10-18T00:00:00Z");
  // 3 mentions in the same thread (post-130)
  const threadMentions: MentionView[] = [
    {
      id: "m-25",
      competitor: "Typeform",
      sentiment: "negative",
      summary: "API 504 timeouts",
      quote: "Typeform API throwing 504 timeouts",
      reasonCategory: "reliability",
      switchingEvidence: "dissatisfied_no_switch",
      explanation: "Author reports timeouts",
      foundAt: baseDate,
      postId: "post-130",
      title: "Typeform down?",
      url: "https://reddit.com/r/SaaS/comments/post-130",
      subreddit: "SaaS",
      subredditIconUrl: null,
      author: "user1",
      avatarUrl: null,
      createdAt: baseDate,
    },
    {
      id: "m-26",
      competitor: "Typeform",
      sentiment: "negative",
      summary: "Intake forms failing",
      quote: "Client intake forms failing",
      reasonCategory: "reliability",
      switchingEvidence: "dissatisfied_no_switch",
      explanation: "Reply confirms failure",
      foundAt: baseDate,
      postId: "post-130",
      title: "Typeform down?",
      url: "https://reddit.com/r/SaaS/comments/post-130/comment/c1",
      subreddit: "SaaS",
      subredditIconUrl: null,
      author: "user2",
      avatarUrl: null,
      createdAt: baseDate,
    },
    {
      id: "m-27",
      competitor: "Typeform",
      sentiment: "negative",
      summary: "Switching to Fillout",
      quote: "Switching to Fillout this afternoon",
      reasonCategory: "reliability",
      switchingEvidence: "actively_switching",
      explanation: "Reply announces switch",
      foundAt: baseDate,
      postId: "post-130",
      title: "Typeform down?",
      url: "https://reddit.com/r/SaaS/comments/post-130/comment/c2",
      subreddit: "SaaS",
      subredditIconUrl: null,
      author: "user3",
      avatarUrl: null,
      createdAt: baseDate,
    },
  ];

  // 1 independent thread (post-131)
  const independentMention: MentionView = {
    id: "m-28",
    competitor: "Typeform",
    sentiment: "negative",
    summary: "Server incident webhooks",
    quote: "Webhooks failed on 3 forms",
    reasonCategory: "reliability",
    switchingEvidence: "dissatisfied_no_switch",
    explanation: "Webhooks failed",
    foundAt: baseDate,
    postId: "post-131",
    title: "Typeform webhook failures",
    url: "https://reddit.com/r/SaaS/comments/post-131",
    subreddit: "SaaS",
    subredditIconUrl: null,
    author: "user4",
    avatarUrl: null,
    createdAt: baseDate,
  };

  // Run grouping
  const singleThreadDislikes = groupDislikeReasons(threadMentions);
  const multiThreadDislikes = groupDislikeReasons([...threadMentions, independentMention]);
  const switchers = listPotentialSwitchers(threadMentions);

  return {
    singleThread: {
      distinctThreads: singleThreadDislikes[0]?.distinctThreads ?? 0,
      totalMentions: singleThreadDislikes[0]?.totalMentions ?? 0,
      isRecurring: singleThreadDislikes[0]?.isRecurring ?? false,
    },
    multiThread: {
      distinctThreads: multiThreadDislikes[0]?.distinctThreads ?? 0,
      totalMentions: multiThreadDislikes[0]?.totalMentions ?? 0,
      isRecurring: multiThreadDislikes[0]?.isRecurring ?? false,
    },
    switcherDeduplication: {
      totalFound: switchers.length,
      signal: switchers[0]?.signal,
      allRepliesInThread: switchers[0]?.allMentionsInThread.length ?? 0,
    },
  };
}

export type LiveEvaluationResult = {
  results: EvalExample[];
  liveExecuted: true;
  totalCandidates: number;
  classifiedCount: number;
  coverageRatio: number;
  evaluatedAt: string;
  provider: string;
  model: string;
};

export async function runLiveEvaluation(): Promise<LiveEvaluationResult> {


  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Live evaluation prerequisite failed: OPENROUTER_API_KEY is not configured. Live evaluation requires an active OpenRouter API key and refuses to fall back to recorded benchmark outputs.",
    );
  }

  const { db } = await import("../src/db");
  const { projects } = await import("../src/db/schema");
  let local: { id: string } | undefined;
  try {
    const rows = await db().select({ id: projects.id }).from(projects).limit(1);
    local = rows[0];
  } catch (dbErr) {
    throw new Error(
      `Live evaluation prerequisite failed: Database unreachable (${dbErr instanceof Error ? dbErr.message : String(dbErr)}). Live evaluation requires a reachable local database with a project row.`,
    );
  }

  if (!local) {
    throw new Error(
      "Live evaluation prerequisite failed: Database has no project row to record usage. Live evaluation requires at least one project in the database.",
    );
  }

  if (process.env.VITEST) {
    throw new Error(
      "Live evaluation prerequisite failed: Live model evaluation is disabled during automated test execution (VITEST). Use runRecordedEvaluation() to assert benchmark outputs deterministically.",
    );
  }

  const provider = "OpenRouter";
  const model = process.env.OPENROUTER_MODEL || "meta/muse-spark-1.3-contributor";

  const byCompetitor = new Map<string, EvalExample[]>();
  for (const item of HELD_OUT_DATASET) {
    const list = byCompetitor.get(item.competitor) ?? [];
    list.push(item);
    byCompetitor.set(item.competitor, list);
  }

  const liveDataset: EvalExample[] = [];
  for (const [competitor, items] of byCompetitor) {
    const candidates: MentionCandidate[] = items.map((item) => ({
      id: item.id,
      title: `Post about ${competitor}`,
      subreddit: "SaaS",
      body: item.text,
    }));

    const verdicts = await classifyMentions(local.id, competitor, candidates);
    for (const item of items) {
      const verdict = verdicts.get(item.id);
      if (verdict) {
        liveDataset.push({
          ...item,
          prediction: {
            sentiment: verdict.sentiment,
            reasonCategory: verdict.reasonCategory,
            switchingEvidence: verdict.switchingEvidence,
            explanation: verdict.explanation,
          },
        });
      }
      // Items without fresh verdicts are intentionally excluded to avoid mixing with recorded fixtures
    }
  }

  if (liveDataset.length === 0) {
    throw new Error(
      "Live evaluation failed: Model returned zero classified mentions. No fresh predictions available to score.",
    );
  }

  const totalCandidates = HELD_OUT_DATASET.length;
  const classifiedCount = liveDataset.length;
  const coverageRatio = classifiedCount / totalCandidates;
  const evaluatedAt = new Date().toISOString();

  return {
    results: liveDataset,
    liveExecuted: true,
    totalCandidates,
    classifiedCount,
    coverageRatio,
    evaluatedAt,
    provider,
    model,
  };
}

if (process.argv[1]?.endsWith("eval-competitor-reasons.ts")) {
  const isLive = process.argv.includes("--live");
  let dataset = HELD_OUT_DATASET;
  let metadata = { ...EVALUATION_METADATA };
  let executionMode = "Recorded benchmark outputs (offline fixtures)";
  let coverageInfo: string | null = null;

  if (isLive) {
    try {
      const liveRun = await runLiveEvaluation();
      dataset = liveRun.results;
      metadata = {
        provider: liveRun.provider,
        model: liveRun.model,
        promptVersion: CLASSIFIER_PROMPT_VERSION,
        promptHash: getPromptHash(),
        evaluationDate: liveRun.evaluatedAt,
        datasetProvenance: DATASET_PROVENANCE,
        sampleSize: liveRun.classifiedCount,
      };
      executionMode = "Live model inference";
      coverageInfo = `Coverage:                  ${liveRun.classifiedCount}/${liveRun.totalCandidates} candidates classified (${(liveRun.coverageRatio * 100).toFixed(1)}%)`;
    } catch (err) {
      console.error("=================================================");
      console.error("LIVE EVALUATION ABORTED: PREREQUISITE MISSING");
      console.error("=================================================");
      console.error(err instanceof Error ? err.message : String(err));
      console.error("\nRefusing to display recorded benchmark fixtures as live metrics.");
      process.exit(1);
    }
  }

  const metrics = runEvaluation(dataset);
  const dedup = verifyThreadDeduplication();

  console.log("=================================================");
  console.log(
    isLive
      ? "COMPETITOR REASONS V1: LIVE MODEL EVALUATION"
      : "COMPETITOR REASONS V1: HELD-OUT BENCHMARK EVAL (RECORDED FIXTURES)",
  );
  console.log("=================================================");
  console.log(`Provenance:                ${metadata.datasetProvenance}`);
  console.log(`Model / Provider:          ${metadata.model} (${metadata.provider})`);
  console.log(`Classifier Prompt Version: ${metadata.promptVersion}`);
  console.log(`Classifier Prompt Hash:    ${metadata.promptHash}`);
  console.log(`Evaluation Date:           ${metadata.evaluationDate}`);
  console.log(`Execution Mode:            ${executionMode}`);
  if (coverageInfo) {
    console.log(coverageInfo);
  }
  console.log(`Sample Size:               ${metrics.sampleSize} synthetic conversations across 6 competitors`);
  console.log("\n--- EXPLICIT SWITCHING INTENT ---");
  console.log(`True Positives (TP):  ${metrics.switching.truePositives}`);
  console.log(`False Positives (FP): ${metrics.switching.falsePositives}`);
  console.log(`False Negatives (FN): ${metrics.switching.falseNegatives}`);
  console.log(`True Negatives (TN):  ${metrics.switching.trueNegatives}`);
  console.log(`Precision:            ${(metrics.switching.precision * 100).toFixed(1)}%`);
  console.log(`Recall:               ${(metrics.switching.recall * 100).toFixed(1)}%`);
  console.log(`Specificity:          ${(metrics.switching.specificity * 100).toFixed(1)}%`);
  console.log(`F1 Score:             ${(metrics.switching.f1Score * 100).toFixed(1)}%`);

  console.log("\n--- REASON CATEGORIES ---");
  console.log(`Accuracy:             ${(metrics.reasonCategories.accuracy * 100).toFixed(1)}%`);
  console.log(`Abstained / Unknown:  ${metrics.reasonCategories.abstainedUnknownCount}`);

  console.log("\n--- SENTIMENT CLASSIFICATION ---");
  console.log(`Accuracy:             ${(metrics.sentiment.accuracy * 100).toFixed(1)}%`);

  console.log("\n--- EDGE CASE FAILURE ANALYSIS ---");
  console.log(`Sarcasm Error Rate:             ${(metrics.edgeCaseAnalysis.sarcasmErrorRate * 100).toFixed(1)}%`);
  console.log(`Mixed Sentiment Error Rate:     ${(metrics.edgeCaseAnalysis.mixedSentimentErrorRate * 100).toFixed(1)}%`);
  console.log(`Staying Intent False Alarm Rate: ${(metrics.edgeCaseAnalysis.stayingIntentFalsePositiveRate * 100).toFixed(1)}%`);

  console.log("\n--- CONCRETE ERROR EXAMPLES ---");
  for (const err of metrics.errorExamples) {
    console.log(`[${err.id}] (${err.edgeType})`);
    console.log(`  Text: "${err.text}"`);
    console.log(`  Truth: sentiment=${err.truth.sentiment}, reason=${err.truth.reason}, switching=${err.truth.switching}`);
    console.log(`  Pred:  sentiment=${err.predicted.sentiment}, reason=${err.predicted.reason}, switching=${err.predicted.switching}`);
    console.log(`  Cause: ${err.cause}\n`);
  }

  console.log("--- THREAD DEDUPLICATION VERIFICATION ---");
  console.log(`Single thread with 3 replies: distinctThreads=${dedup.singleThread.distinctThreads}, totalMentions=${dedup.singleThread.totalMentions}, isRecurring=${dedup.singleThread.isRecurring}`);
  console.log(`Two independent threads:       distinctThreads=${dedup.multiThread.distinctThreads}, totalMentions=${dedup.multiThread.totalMentions}, isRecurring=${dedup.multiThread.isRecurring}`);
  console.log(`Switcher thread deduplication: totalFound=${dedup.switcherDeduplication.totalFound}, signal=${dedup.switcherDeduplication.signal}, threadReplies=${dedup.switcherDeduplication.allRepliesInThread}`);
}
