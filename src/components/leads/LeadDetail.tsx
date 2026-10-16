import {
  hideLeadAction,
  markNotFitAction,
  muteSubredditAction,
  recordLeadOutcomeAction,
  reopenLeadAction,
  repliedLeadAction,
} from "@/app/app/leads/actions";
import { Avatar } from "@/components/Avatar";
import { AuthorAvatar } from "@/components/AuthorAvatar";
import { VerdictBadge } from "@/components/VerdictBadge";
import { SubredditChip } from "@/components/SubredditChip";
import { DetailRail } from "@/components/leads/DetailRail";
import { HighlightedBody } from "@/components/leads/HighlightedBody";
import { LeadActions } from "@/components/leads/LeadActions";
import { Called, Pane, Title } from "@/components/leads/pane";
import { PromoPolicyBadge } from "@/components/leads/PromoPolicyBadge";
import { WorthACommentChip } from "@/components/leads/WorthACommentChip";
import { verdictFor } from "@/components/leads/verdict";
import { relativeAge } from "@/lib/format";
import { intentWord } from "@/lib/scan/words";
import { rankingSentence, type ScoringSettings } from "@/lib/scoring/weights";

import type { Selection } from "@/components/leads/workspace";
import { redditAvatar } from "@/lib/redditAvatar";

type LeadDetailProps = {
  selection: Selection;
  projectId: string;
  /** The project's competitors named in the selected lead's thread. */
  competitors: string[];
  /** The owner's ranking weights, null for the default, which the ranking line reads. */
  scoring: ScoringSettings | null;
};

/** The thread a comment lead was found under, so the reply has its context. */
function ReplyingIn({ title, author, avatarUrl }: { title: string; author: string | null; avatarUrl: string | null }) {
  return (
    <div className="text-mono flex items-center gap-2 rounded-control bg-surface-2 px-2 py-1 text-fg-muted">
      <Avatar name={author} src={redditAvatar(author, avatarUrl)} size={16} />
      <span className="truncate">Replying in: {title}</span>
    </div>
  );
}

/** The whole post or comment, beside the ledger of facts about who wrote it. */
export function LeadDetail({ selection, projectId, competitors, scoring }: LeadDetailProps) {
  if (selection.kind === "held") {
    const item = selection.item;
    const verdict = verdictFor(item);
    return (
      <Pane>
        <header className="flex flex-col gap-2 border-b p-4">
          <Title
            text={item.title}
            badge={
              <span className="text-small text-fg-muted" style={{ fontWeight: 500 }}>
                {verdict.label}
              </span>
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <AuthorAvatar name={item.author} src={item.avatarUrl} size={24} />
            <span className="text-small text-fg-muted">u/{item.author ?? "unknown"}</span>
            <SubredditChip name={item.subreddit} iconUrl={item.subredditIconUrl} />
            <span className="text-mono text-fg-muted">{relativeAge(item.createdAt)}</span>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4 xl:flex-row">
          <div className="flex min-w-0 flex-col gap-3 xl:flex-1">
            <Called label={`Held: ${verdict.label}`} sentence={item.reason} />
            <ul className="flex flex-col gap-1">
              {verdict.codes.map((code) => (
                <li key={code} className="text-small text-fg-muted">
                  {code}
                </li>
              ))}
            </ul>
          </div>
          <DetailRail
            projectId={null}
            author={item.author}
            avatarUrl={item.avatarUrl}
            authorKarma={item.authorKarma}
            authorCreatedAt={item.authorCreatedAt}
            subreddit={item.subreddit}
            subredditIconUrl={item.subredditIconUrl}
            weeklyActive={null}
            promoPolicy={null}
            rulesText={null}
            points={item.points}
            numComments={item.numComments}
            url={item.url}
            fit={item.fit}
            intent={item.intent}
            engagement={null}
            competitors={[]}
          />
        </div>
      </Pane>
    );
  }

  const lead = selection.entry.lead;
  return (
    <Pane>
      <header className="flex flex-col gap-2 border-b p-4">
        <Title text={lead.title} badge={<VerdictBadge fit={lead.fit} intent={lead.intent} />} />
        <div className="flex flex-wrap items-center gap-2">
          <AuthorAvatar name={lead.author} src={lead.avatarUrl} size={24} />
          <span className="text-small text-fg-muted">u/{lead.author ?? "unknown"}</span>
          <SubredditChip name={lead.subreddit} iconUrl={lead.subredditIconUrl} />
          <span className="text-mono text-fg-muted">{relativeAge(lead.createdAt)}</span>
          {intentWord(lead.intent) ? (
            <span className="rounded-control bg-surface-2 px-2 py-0.5 text-mono text-fg-muted">
              {intentWord(lead.intent)}
            </span>
          ) : null}
          <WorthACommentChip kind={lead.kind} />
          <PromoPolicyBadge
            projectId={projectId}
            subreddit={lead.subreddit}
            policy={lead.promoPolicy}
            rulesText={lead.rulesText}
          />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4 xl:flex-row">
        <div className="flex min-w-0 flex-col gap-3 xl:flex-1">
          <Called label="Why this is a lead" sentence={lead.reason} />
          {/* A lead kept from before its verdict was stored has no model score to rank from. */}
          {lead.quality === null ? null : (
            <Called label="Why it ranks here" sentence={rankingSentence(lead, scoring)} />
          )}
          {lead.isComment ? (
            <ReplyingIn
              title={lead.title}
              author={lead.postAuthor}
              avatarUrl={lead.postAuthorAvatar}
            />
          ) : null}
          {lead.body ? (
            <HighlightedBody text={lead.body} phrase={lead.matchedPhrase} />
          ) : (
            <p className="text-body text-fg-muted">A title only, with no text of its own.</p>
          )}
        </div>
        <DetailRail
          projectId={projectId}
          author={lead.author}
          avatarUrl={lead.avatarUrl}
          authorKarma={lead.authorKarma}
          authorCreatedAt={lead.authorCreatedAt}
          subreddit={lead.subreddit}
          subredditIconUrl={lead.subredditIconUrl}
          weeklyActive={lead.subredditWeeklyActive}
          promoPolicy={lead.promoPolicy}
          rulesText={lead.rulesText}
          points={lead.points}
          numComments={lead.numComments}
          url={lead.url}
          fit={lead.fit}
          intent={lead.intent}
          engagement={lead.engagement}
          competitors={competitors}
        />
      </div>
      <LeadActions
        openLabel="Open on Reddit"
        url={lead.url}
        replied={lead.status === "replied"}
        outcome={lead.outcome}
        outcomeNotes={lead.outcomeNotes}
        actions={{
          replied: repliedLeadAction.bind(null, projectId, lead.id),
          reopen: reopenLeadAction.bind(null, projectId, lead.id),
          hide: hideLeadAction.bind(null, projectId, lead.id),
          notFit: markNotFitAction.bind(null, projectId, lead.id),
          recordOutcome: recordLeadOutcomeAction.bind(null, projectId, lead.id),
          mute: { label: `Mute r/${lead.subreddit}`, action: muteSubredditAction.bind(null, projectId, lead.subreddit) },
        }}
      />
    </Pane>
  );
}
