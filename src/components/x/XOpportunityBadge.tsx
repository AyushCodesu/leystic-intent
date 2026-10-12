import { VerdictBadge } from "@/components/VerdictBadge";
import { X_PRIORITY_FLOOR } from "@/lib/x/priority";
import type { XOpportunity } from "@/lib/x/read";
import { XReplyChip } from "./XReplyChip";

/** Describe the evidence, without presenting the internal ordering as a probability. */
export function XOpportunityBadge({ opportunity, ranked = true }: { opportunity: XOpportunity; ranked?: boolean }) {
  const { entry, priority, checks } = opportunity;
  const weaker = ranked && (priority === null || priority < X_PRIORITY_FLOOR);
  // History preserves its original verdict. New uses the evidence that orders
  // it, not an old qualification state that can contradict that order.
  if (!ranked && entry.kind === "lead") {
    return entry.lead.kind === "reply"
      ? <XReplyChip moment={entry.lead.moment} />
      : <VerdictBadge fit={entry.lead.fit} intent={entry.lead.intent} />;
  }
  const word = weaker ? priority === null ? "Unassessed" : "Weaker match" : "Potential match";
  const hint = weaker
    ? priority === null ? "Not enough evidence to assess this opportunity yet." : "Less evidence of a useful opportunity. You can still review the post."
    : ["Potentially relevant, not a verified good lead. Review the post before replying.", ...checks].join(" · ");
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-mono whitespace-nowrap ${weaker ? "text-fg-muted" : "text-score-warm"}`} title={hint}>
      {word}
    </span>
  );
}
