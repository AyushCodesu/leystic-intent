import { ExternalLink, Eye, Heart, MessageCircle, Search } from "lucide-react";
import {
  hideXLeadAction,
  notFitXLeadAction,
  reopenXEvaluationAction,
  reopenXLeadAction,
  repliedXEvaluationAction,
  repliedXLeadAction,
} from "@/app/app/x/actions";
import { AuthorAvatar } from "@/components/AuthorAvatar";
import { VerdictBadge } from "@/components/VerdictBadge";
import { HighlightedBody } from "@/components/leads/HighlightedBody";
import { LeadActions } from "@/components/leads/LeadActions";
import { Meter } from "@/components/leads/Meter";
import { Block, Called, Pane, Title } from "@/components/leads/pane";
import { accountAge } from "@/components/leads/workspace";
import { XReplyChip } from "@/components/x/XReplyChip";
import { XOpportunityBadge } from "@/components/x/XOpportunityBadge";
import { XThread } from "@/components/x/XThread";
import { filteredSentence } from "@/components/x/filtered";
import { fullCount, relativeAge, shortAge } from "@/lib/format";
import { intentWord, judgementSentence } from "@/lib/scan/words";
import { STALE_BADGE_HOURS } from "@/lib/x/constants";
import type { XFilteredCard, XHeldCard, XLeadCard, XOpportunity, XThread as XThreadData } from "@/lib/x/read";

export type XSelection =
  | { kind: "lead"; lead: XLeadCard }
  | { kind: "held"; item: XHeldCard }
  | { kind: "filtered"; item: XFilteredCard };

/** Why a post worth a reply was a miss. "No active need" is true of every reply by construction. */
const REPLY_NOT_FIT_REASONS = ["can't help them", "not worth replying", "seller side", "other"];

/** The posts a reply answers, so it is read with them. Never tinted: their need is not the author's. */
function ReplyingTo({ parents }: { parents: string[] }) {
  if (parents.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1">
      {parents.map((parent) => (
        <div key={parent} className="text-mono flex items-start gap-2 rounded-control bg-surface-2 px-2 py-1 text-fg-muted">
          <span className="line-clamp-2">Replying to {parent}</span>
        </div>
      ))}
    </div>
  );
}

type RailProps = {
  card: XLeadCard | XHeldCard | XFilteredCard;
  engagement: number | null;
  /** A reply was not scored for fit and intent the way an ask is, so only its freshness is shown. */
  reply?: boolean;
  /** A post the screen set aside was never scored, so it has no scores to show. */
  unscored?: boolean;
  /** For a reply, what kind of place it is: someone with the problem, or a venue where buyers are reading. */
  moment?: string | null;
};

/**
 * The ledger beside an X post, block for block the Reddit DetailRail: who is
 * asking, what the post drew, which search found it, how to answer on X, and
 * how the scan scored it.
 */
function XDetailRail({ card, engagement, reply = false, unscored = false, moment = null }: RailProps) {
  return (
    <aside className="shrink-0 rounded-card border bg-surface xl:w-[var(--rail-width)] xl:self-start">
      <Block label="Author">
        <span className="flex items-center gap-2">
          <AuthorAvatar name={card.authorName ?? card.authorUsername} src={card.authorImage} size={24} platform="x" />
          <span className="min-w-0 truncate text-small text-fg">@{card.authorUsername}</span>
        </span>
        <span className="text-mono tabular-nums text-fg-muted">
          {fullCount(card.authorFollowers)} followers{card.authorVerified ? " · verified" : ""}
        </span>
        {card.authorLocation ? <span className="text-small truncate text-fg-muted">{card.authorLocation}</span> : null}
        <span className="text-mono text-fg-muted">{accountAge(card.authorCreatedAt)}</span>
        {card.authorBio ? <p className="text-small line-clamp-3 text-fg-muted">{card.authorBio}</p> : null}
      </Block>

      <Block label="Post">
        <span className="text-mono flex items-center gap-3 tabular-nums text-fg-muted">
          <span className="inline-flex items-center gap-1">
            <Heart className="size-3.5" aria-hidden="true" />
            {fullCount(card.likeCount)}
          </span>
          <span className="inline-flex items-center gap-1">
            <MessageCircle className="size-3.5" aria-hidden="true" />
            {fullCount(card.replyCount)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Eye className="size-3.5" aria-hidden="true" />
            {fullCount(card.viewCount)}
          </span>
        </span>
        <span className="text-mono text-fg-muted">counted {relativeAge(card.fetchedAt)}</span>
        <a
          href={card.url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-mono inline-flex items-center gap-1 text-fg-muted hover:text-fg"
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
          Open on X
        </a>
      </Block>

      {card.foundBy || card.via ? (
        <Block label="Found by">
          {card.foundBy || card.via?.phrase ? (
            <span className="text-mono inline-flex items-center gap-1 text-fg-muted">
              <Search className="size-3.5 shrink-0" aria-hidden="true" />
              {card.foundBy ?? card.via?.phrase}
            </span>
          ) : null}
          {card.via ? (
            <>
              <p className="text-small text-fg-muted">
                {card.foundBy
                  ? `lurk also reached it through a reply in its thread by @${card.via.author}.`
                  : `lurk reached it through a reply in its thread by @${card.via.author}${card.via.phrase ? ", which used these words" : ""}.`}
              </p>
              <a
                href={card.via.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-mono inline-flex items-center gap-1 text-fg-muted hover:text-fg"
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
                Open the reply
              </a>
            </>
          ) : null}
        </Block>
      ) : null}

      <Block label="Replying on X">
        <p className="text-small text-fg-muted">
          {reply && moment && moment !== "has_the_problem"
            ? "The people reading this are your buyers, so the reply is for them as much as the author. Add what the post is missing, a cheaper or easier way to do a step it shows or a limit they will hit, and say you make it. Replies in the first few hours are read the most. Leave the link out of the first reply: X shows link replies to fewer people."
            : reply
              ? "Nobody here is shopping, so help with what they said first. Mention your product only if it answers them, and say you make it. Leave the link out of the first reply: X shows link replies to fewer people."
              : "Reply yourself, in public and in your own words. Answer what they asked first and leave the link out of the first reply: X shows link replies to fewer people. Message them only if they answer."}
        </p>
      </Block>

      {unscored ? null : (
        <Block label="How it scored">
          {reply ? null : (
            <>
              <Meter label="Fit" value={card.fit} hint={judgementSentence(card.fit, null) ?? "Whether your product is what they need"} />
              <Meter
                label="Intent"
                value={card.intent}
                hint={judgementSentence(null, card.intent) ?? "How far along they are toward changing it"}
              />
            </>
          )}
          <Meter label="Engagement" value={engagement} hint="How fresh the post is and how much room its replies leave" />
        </Block>
      )}
    </aside>
  );
}

/** The whole post beside the ledger of facts about who wrote it, as LeadDetail is for Reddit. */
export function XLeadDetail({
  selection,
  projectId,
  thread = null,
  now = new Date(),
  opportunity,
  replied = false,
}: {
  selection: XSelection;
  projectId: string;
  /** The stored thread around the post, drawn as X draws it; without it the post's own words stand alone. */
  thread?: XThreadData | null;
  now?: Date;
  opportunity?: Pick<XOpportunity, "priority" | "checks" | "notes">;
  /** For a post that is not a lead: its conversation is already marked replied. */
  replied?: boolean;
}) {
  if (selection.kind !== "lead") {
    const item = selection.item;
    const filtered = selection.kind === "filtered" ? selection.item : null;
    const warm = !filtered || filtered.band === "worth";
    const badge = warm ? "Maybe" : "Left out";
    return (
      <Pane>
        <header className="flex flex-col gap-2 border-b p-4">
          <Title
            text={item.headline}
            badge={
              opportunity ? <XOpportunityBadge opportunity={{ entry: selection, ...opportunity }} /> : <span className={`text-small ${warm ? "text-score-warm" : "text-fg-muted"}`} style={{ fontWeight: 500 }}>
                {badge}
              </span>
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <AuthorAvatar name={item.authorName ?? item.authorUsername} src={item.authorImage} size={24} platform="x" />
            <span className="text-small text-fg-muted">@{item.authorUsername}</span>
            <span className="text-mono text-fg-muted">{relativeAge(item.postedAt)}</span>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4 xl:flex-row">
          <div className="flex min-w-0 flex-col gap-3 xl:flex-1">
            {opportunity?.checks.length ? <Called label="Before replying" sentence={opportunity.checks.join(" · ")} /> : null}
            {opportunity?.notes?.length ? <Called label="Product fit" sentence={opportunity.notes.join(" · ")} /> : null}
            <Called
              label={opportunity ? "Fit notes" : warm ? "Why lurk is unsure" : "Why lurk left it out"}
              sentence={filtered ? filteredSentence(filtered) : item.reason}
            />
            {thread ? (
              <XThread thread={thread} quote={null} now={now} />
            ) : (
              <>
                <ReplyingTo parents={item.replyingTo} />
                <HighlightedBody text={item.text} phrase={null} linkify />
              </>
            )}
          </div>
          <XDetailRail card={item} engagement={item.engagement} unscored={filtered?.kind === "screened" && filtered.score === null} />
        </div>
        {/* Not a lead, so only Replied, which marks the conversation and needs no lead row. */}
        <LeadActions
          openLabel="Open on X"
          url={item.url}
          replied={replied}
          actions={{
            replied: repliedXEvaluationAction.bind(null, projectId, item.evaluationId),
            reopen: reopenXEvaluationAction.bind(null, projectId, item.evaluationId),
          }}
        />
      </Pane>
    );
  }

  const lead = selection.lead;
  const reply = lead.kind === "reply";
  const older = now.getTime() - lead.postedAt.getTime() > STALE_BADGE_HOURS * 3_600_000;
  return (
    <Pane>
      <header className="flex flex-col gap-2 border-b p-4">
        <Title text={lead.headline} badge={reply ? <XReplyChip moment={lead.moment} /> : <VerdictBadge fit={lead.fit} intent={lead.intent} />} />
        <div className="flex flex-wrap items-center gap-2">
          <AuthorAvatar name={lead.authorName ?? lead.authorUsername} src={lead.authorImage} size={24} platform="x" />
          <span className="text-small text-fg-muted">@{lead.authorUsername}</span>
          <span className="text-mono text-fg-muted">{relativeAge(lead.postedAt)}</span>
          {lead.foundAt > lead.postedAt ? (
            <span className="text-mono text-fg-muted">found {shortAge(lead.postedAt, lead.foundAt)} later</span>
          ) : null}
          {!reply && intentWord(lead.intent) ? (
            <span className="rounded-control bg-surface-2 px-2 py-0.5 text-mono text-fg-muted">{intentWord(lead.intent)}</span>
          ) : null}
          {older ? <span className="rounded-control bg-surface-2 px-2 py-0.5 text-mono text-fg-muted">older</span> : null}
          {reply && lead.fresh ? (
            <span className="rounded-control bg-surface-2 px-2 py-0.5 text-mono text-fg-muted">reply now: still being read</span>
          ) : null}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4 xl:flex-row">
        <div className="flex min-w-0 flex-col gap-3 xl:flex-1">
          {opportunity?.checks.length ? <Called label="Before replying" sentence={opportunity.checks.join(" · ")} /> : null}
          {opportunity?.notes?.length ? <Called label="Product fit" sentence={opportunity.notes.join(" · ")} /> : null}
          {thread ? (
            <XThread thread={thread} quote={lead.quote} now={now} />
          ) : (
            <>
              <ReplyingTo parents={lead.replyingTo} />
              <HighlightedBody text={lead.text} phrase={lead.quote} linkify />
            </>
          )}
        </div>
        <XDetailRail card={lead} engagement={lead.engagement} reply={reply} moment={lead.moment} />
      </div>
      <LeadActions
        openLabel="Open on X"
        url={lead.url}
        replied={lead.status === "replied"}
        actions={{
          replied: repliedXLeadAction.bind(null, projectId, lead.id),
          reopen: reopenXLeadAction.bind(null, projectId, lead.id),
          hide: hideXLeadAction.bind(null, projectId, lead.id),
          notFit: notFitXLeadAction.bind(null, projectId, lead.id),
        }}
        reasons={reply ? REPLY_NOT_FIT_REASONS : undefined}
      />
    </Pane>
  );
}
