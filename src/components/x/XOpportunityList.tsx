import { entryHref } from "@/components/leads/workspace";
import { XLeadRow, repliedHandle } from "./XLeadRow";
import { compactCount } from "@/lib/format";
import { X_PRIORITY_FLOOR } from "@/lib/x/priority";
import { xOpportunityCard, type XLeadCard, type XOpportunity } from "@/lib/x/read";
import { XOpportunityBadge } from "./XOpportunityBadge";

/**
 * What a lead's row says after its age: how many had seen the post at lurk's
 * last fetch of it, for a post worth a reply whether a reply now still lands,
 * and for a post found through a reply in its thread whose reply that was.
 */
function leadMeta(lead: XLeadCard): string | null {
  const views = lead.viewCount !== null && lead.viewCount > 0 ? `${compactCount(lead.viewCount)} views` : null;
  const via = lead.via && !lead.foundBy ? `via @${lead.via.author}'s reply` : null;
  return [lead.kind === "reply" && lead.fresh ? "reply now" : null, views, via].filter(Boolean).join(" · ") || null;
}

/**
 * Rows in the order given. Leads (and History) carry their verdict: Good
 * lead, Strong lead, or why a post is worth a reply. Posts that are not leads
 * carry `ranked` evidence words instead, drawn quieter below the floor.
 */
export function XOpportunityList({ items, params, selectedId, ranked = false }: {
  items: XOpportunity[];
  params: Record<string, string | undefined>;
  selectedId: string | null;
  ranked?: boolean;
}) {
  return items.map((opportunity) => {
    const card = xOpportunityCard(opportunity.entry);
    const { entry } = opportunity;
    const meta = entry.kind === "lead" && !ranked ? leadMeta(entry.lead) : opportunity.checks.join(" · ") || null;
    const weaker = ranked && (opportunity.priority === null || opportunity.priority < X_PRIORITY_FLOOR);
    return (
      <div key={card.entryId} className={`border-b last:border-b-0 ${weaker ? "bg-bg" : ""}`}>
        <XLeadRow
          id={card.entryId} href={entryHref(params, card.entryId)} selected={card.entryId === selectedId}
          headline={card.headline} author={card.authorUsername} avatarUrl={card.authorImage}
          createdAt={card.postedAt} replyingTo={repliedHandle(card.replyingTo)} meta={meta}
          subdued={weaker}
          trailing={<XOpportunityBadge opportunity={opportunity} ranked={ranked} />}
        />
      </div>
    );
  });
}
