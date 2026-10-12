import { entryHref } from "@/components/leads/workspace";
import { XLeadRow, repliedHandle } from "./XLeadRow";
import { X_PRIORITY_FLOOR } from "@/lib/x/priority";
import { xOpportunityCard, type XOpportunity } from "@/lib/x/read";
import { XOpportunityBadge } from "./XOpportunityBadge";

/** One order, with an honest quality divider rather than separate certainty buckets. */
export function XOpportunityList({ items, params, selectedId, showDivider = true }: {
  items: XOpportunity[];
  params: Record<string, string | undefined>;
  selectedId: string | null;
  showDivider?: boolean;
}) {
  const weakAt = items.findIndex((item) => item.priority === null || item.priority < X_PRIORITY_FLOOR);
  return items.map((opportunity, index) => {
    const card = xOpportunityCard(opportunity.entry);
    const reply = opportunity.entry.kind === "lead" && opportunity.entry.lead.kind === "reply";
    const meta = [reply ? "public reply" : null, ...opportunity.checks].filter(Boolean).join(" · ") || null;
    const weaker = showDivider && (opportunity.priority === null || opportunity.priority < X_PRIORITY_FLOOR);
    return (
      <div key={card.entryId} className={`border-b last:border-b-0 ${weaker ? "bg-bg" : ""}`}>
        {showDivider && index === weakAt ? (
          <div className="border-y bg-surface-2 px-3 py-4">
            <p className="text-small font-medium text-fg">Weaker matches below</p>
            <p className="mt-1 text-mono text-fg-muted">Less evidence. Still available to review.</p>
          </div>
        ) : null}
        <XLeadRow
          id={card.entryId} href={entryHref(params, card.entryId)} selected={card.entryId === selectedId}
          headline={card.headline} author={card.authorUsername} avatarUrl={card.authorImage}
          createdAt={card.postedAt} replyingTo={repliedHandle(card.replyingTo)} meta={meta}
          subdued={weaker}
          trailing={<XOpportunityBadge opportunity={opportunity} ranked={showDivider} />}
        />
      </div>
    );
  });
}
