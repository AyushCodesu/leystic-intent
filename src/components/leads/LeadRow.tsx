import { AuthorAvatar } from "@/components/AuthorAvatar";
import { RowLink } from "@/components/leads/RowLink";
import { SubredditChip } from "@/components/SubredditChip";
import { shortAge } from "@/lib/format";

type LeadRowProps = {
  /** The entry id in the URL, which is also what the pane opens on. */
  id: string;
  href: string;
  selected: boolean;
  title: string;
  /** A comment lead's own words. The row is headed by them, not by the thread. */
  excerpt?: string | null;
  /** Whether the row above is the same thread, which this one then sits under. */
  nested?: boolean;
  author: string | null;
  avatarUrl: string | null;
  subreddit: string;
  subredditIconUrl: string | null;
  createdAt: Date;
  /** The one thing the row rates by: a score for a lead, a verdict for a held item. */
  trailing: React.ReactNode;
  learnedTier?: 1 | 2 | 3;
  learnedExplanation?: string;
};

/**
 * One line in the list column. It carries only what picks a row out of eighty:
 * the face, the ask, the community, the age, and one rating. The prose and the
 * judgement bars live in the detail pane, which is where they are read.
 *
 * Everything on this row is also everything the pane needs to open, so the row
 * hands it over on the click rather than making the pane wait to be told.
 *
 * A comment lead is headed by what the comment says. Its thread is named under
 * it, unless the row above already is that thread, and then it is indented
 * beneath it instead.
 */
export function LeadRow({
  id,
  href,
  selected,
  title,
  excerpt,
  nested,
  author,
  avatarUrl,
  subreddit,
  subredditIconUrl,
  createdAt,
  trailing,
  learnedTier,
  learnedExplanation,
}: LeadRowProps) {
  return (
    <RowLink
      href={href}
      selectedOnServer={selected}
      nested={nested}
      summary={{ id, title, author, avatarUrl, subreddit, subredditIconUrl, createdAt, trailing }}
    >
      <AuthorAvatar name={author} src={avatarUrl} size={24} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-small text-fg max-sm:line-clamp-2 sm:truncate" style={{ fontWeight: 500 }}>
          {excerpt ?? title}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          {nested ? (
            <span className="text-small min-w-0 truncate text-fg-muted">
              u/{author ?? "unknown"} replied
            </span>
          ) : (
            <SubredditChip
              name={subreddit}
              iconUrl={subredditIconUrl}
              className={excerpt ? "shrink-0" : "min-w-0 truncate"}
            />
          )}
          <span className="text-mono shrink-0 text-fg-muted">{shortAge(createdAt)}</span>
          {learnedTier === 1 ? (
            <span
              className="rounded-control bg-brand-soft px-1.5 py-0.5 text-mono text-brand shrink-0 text-[10px] font-medium"
              title={learnedExplanation}
            >
              Promising
            </span>
          ) : learnedTier === 3 ? (
            <span
              className="rounded-control bg-surface-2 px-1.5 py-0.5 text-mono text-fg-muted shrink-0 text-[10px]"
              title={learnedExplanation}
            >
              Deprioritized
            </span>
          ) : null}
          {excerpt && !nested ? (
            <span className="text-small min-w-0 flex-1 truncate text-fg-muted">in: {title}</span>
          ) : null}
        </span>
      </span>
      <span className="shrink-0 pt-0.5">{trailing}</span>
    </RowLink>
  );
}
