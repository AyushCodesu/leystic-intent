/**
 * Display priority only. Never qualifies a lead, sends an alert or buys context.
 * These are explicit heuristics, not calibrated adoption/conversion probabilities.
 * Freeze a new version before any later unseen owner-feedback comparison.
 */
export const X_PRIORITY_VERSION = "x-attention-2026-10-12.1";
export const X_PRIORITY_FLOOR = 0.4;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bounded(value: unknown, maximum = 1): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
}

function noul(signals: Record<string, unknown>, key: string): number | null {
  const answer = record(signals[key]);
  return answer.type === "noul" ? bounded(answer.noul) : null;
}

/** Gateways may omit probabilities. Use the unrounded score in that case. */
export function expectedXIntent(value: unknown): number | null {
  const answer = record(value);
  if (answer.type !== "score") return null;
  const probabilities = record(answer.probabilities);
  const entries = Object.entries(probabilities);
  if (entries.length > 0 && entries.every(([level, mass]) => /^[0-4]$/u.test(level) && bounded(mass) !== null)) {
    const total = entries.reduce((sum, [, mass]) => sum + (mass as number), 0);
    // Do not interpret incomplete/malformed distributions as confidence.
    if (total >= 0.95 && total <= 1.05) {
      return entries.reduce((sum, [level, mass]) => sum + Number(level) * (mass as number), 0) / total;
    }
  }
  return bounded(answer.score, 4);
}

export type XPriorityInput = {
  key: string;
  author: string;
  postedAt: Date;
  engagement: number | null;
  signals: unknown;
  level: string | null;
  /** Pipeline's final verdict marker, not the model's raw worth_reply answer. */
  replyVerdictCode?: string | null;
};

export type XPriority = {
  priority: number | null;
  checks: string[];
  /** Neutral detail-only caveats, not extra list-wide action checks. */
  notes: string[];
  /** Internal replay diagnostics, never displayed as calibrated probabilities. */
  needPriority: number | null;
  conversationPriority: number | null;
};

export function xPriority(input: Pick<XPriorityInput, "signals" | "level" | "replyVerdictCode">): XPriority {
  const signals = record(input.signals);
  const checks: string[] = [];
  const notes: string[] = [];
  const own = noul(signals, "own_need");
  // Only answers xQuestions() asks (plus the pipeline's own reply check) are
  // read (tests/xPriority.test.ts holds this): a signal no level produces is a term the app never fills.
  const fit = noul(signals, "same_kind");
  const intent = expectedXIntent(signals.intent);
  const seller = noul(signals, "rival_vendor");
  const promoting = noul(signals, "promoting");
  const resolved = noul(signals, "resolved");
  const reply = record(signals.reply);
  const failedReply = reply.worth_reply === false || reply.code === "not_reply_worthy";
  const verifiedReply = input.replyVerdictCode === "worth_reply" && reply.worth_reply === true && !failedReply && reply.code == null;
  if (input.level !== "complete" && !verifiedReply) checks.push("Check author and context");
  const requirement = record(signals.hard_requirement);
  const validRequirement = requirement.type === "choice" && typeof requirement.choice === "string" && ["met", "unmet", "unknown", "none_stated"].includes(requirement.choice);
  if (!validRequirement || requirement.choice === "unknown") checks.push("Check requirements");
  // Absence of an extracted requirement is not proof of product compatibility.
  if (validRequirement && requirement.choice === "none_stated") notes.push("No specific requirement identified. Product compatibility is unverified.");
  const unmet = requirement.type === "choice" && requirement.choice === "unmet";
  if (unmet) checks.push("Requirement may not fit");
  if (failedReply) checks.push("Public reply not recommended");
  // No commercial/personal/free-use penalty.
  let needPriority = own !== null && fit !== null && intent !== null && seller !== null && promoting !== null && resolved !== null
    ? own * fit * ((intent + 1) / 5) * (1 - seller) * (1 - promoting) * (1 - resolved)
    : null;
  // Keep checked public conversations: a workflow/venue need not be an adopter
  // asking for themselves. This bounded term requires the actual completed
  // reply check, not a high unverified founder_would_reply answer alone.
  const founder = noul(signals, "founder_would_reply");
  let conversationPriority = verifiedReply && founder !== null && fit !== null && seller !== null
    ? 0.5 * founder * fit * (1 - seller)
    : null;
  if (unmet) {
    if (needPriority !== null) needPriority *= 0.2;
    if (conversationPriority !== null) conversationPriority *= 0.2;
  }
  const available = [needPriority, conversationPriority].filter((value): value is number => value !== null);
  const priority = available.length ? Math.max(...available) : null;
  if (priority === null) checks.push("Not enough scoring evidence");
  else if (needPriority === null) checks.push("Adoption assessment incomplete");
  return { priority, needPriority, conversationPriority, checks, notes };
}

/** No stage/band/date cap before ranking; unknown scores come last, not zero. */
export function rankXOpportunities<T extends XPriorityInput>(inputs: T[], deduplicate = true): (T & XPriority)[] {
  const ranked = inputs.map((input) => ({ ...input, ...xPriority(input) })).sort((a, b) =>
    (b.priority ?? -1) - (a.priority ?? -1) || b.postedAt.getTime() - a.postedAt.getTime() ||
    (b.engagement ?? -1) - (a.engagement ?? -1) || a.key.localeCompare(b.key),
  );
  if (!deduplicate) return ranked;
  const authors = new Set<string>();
  return ranked.filter((item) => {
    const author = item.author.trim().toLowerCase() || item.key;
    if (authors.has(author)) return false;
    authors.add(author);
    return true;
  });
}
