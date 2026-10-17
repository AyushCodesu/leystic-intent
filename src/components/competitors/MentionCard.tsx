import { AuthorAvatar } from "@/components/AuthorAvatar";
import { SubredditChip } from "@/components/SubredditChip";
import { SENTIMENT_DOT, SENTIMENT_WORD } from "@/components/competitors/sentiment";
import { relativeAge } from "@/lib/format";
import type { MentionView } from "@/lib/competitors/read";
import { cn } from "@/lib/utils";

import { REASON_CATEGORY_LABELS, SWITCHING_EVIDENCE_LABELS } from "@/lib/competitors/classify";

type MentionCardProps = { mention: MentionView };

/** What a mention with no sentiment is: named in a thread this project already reads. */
const IN_YOUR_THREAD = "Named in one of your threads";

/** One post or reply that named a competitor, and what it said. */
export function MentionCard({ mention }: MentionCardProps) {
  return (
    <div className="flex flex-col gap-2.5 rounded-card border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <AuthorAvatar name={mention.author} src={mention.avatarUrl} size={28} />
        <span className="text-small text-fg" style={{ fontWeight: 500 }}>
          u/{mention.author ?? "unknown"}
        </span>
        <SubredditChip name={mention.subreddit} iconUrl={mention.subredditIconUrl} />
        <span className="text-mono text-fg-muted">{relativeAge(mention.createdAt)}</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-small text-fg-muted">
          {mention.sentiment === null ? (
            IN_YOUR_THREAD
          ) : (
            <>
              <span
                className={cn("size-2 rounded-full", SENTIMENT_DOT[mention.sentiment])}
                aria-hidden="true"
              />
              {SENTIMENT_WORD[mention.sentiment]}
            </>
          )}
        </span>
      </div>
      <a
        href={mention.url}
        target="_blank"
        rel="noreferrer noopener"
        className="transition-motion text-h3 text-fg transition-colors hover:text-fg-muted"
        style={{ fontWeight: 500 }}
      >
        {mention.title}
      </a>
      {mention.summary ? (
        <p className="rounded-card bg-surface-2 p-3 text-small text-fg-muted">{mention.summary}</p>
      ) : mention.quote ? (
        <blockquote className="rounded-card bg-surface-2 p-3 text-small text-fg-muted">
          {mention.quote}
        </blockquote>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-mono text-fg-muted">about {mention.competitor}</span>
        {mention.reasonCategory && mention.reasonCategory !== "unknown" ? (
          <span className="rounded-control bg-surface-2 px-2 py-0.5 text-small text-fg-muted">
            {REASON_CATEGORY_LABELS[mention.reasonCategory]}
          </span>
        ) : null}
        {mention.switchingEvidence && mention.switchingEvidence !== "no_clear_signal" ? (
          <span
            className={cn(
              "rounded-control px-2 py-0.5 text-small font-medium",
              mention.switchingEvidence === "actively_switching"
                ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                : mention.switchingEvidence === "evaluating_alternatives"
                  ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                  : "bg-surface-2 text-fg-muted",
            )}
          >
            {SWITCHING_EVIDENCE_LABELS[mention.switchingEvidence]}
          </span>
        ) : null}
      </div>
    </div>
  );
}
