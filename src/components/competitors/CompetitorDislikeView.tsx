import { AlertCircle, ChevronDown, ExternalLink } from "lucide-react";
import { AuthorAvatar } from "@/components/AuthorAvatar";
import { CompetitorChip } from "@/components/competitors/CompetitorChip";
import { EmptyState } from "@/components/EmptyState";
import { SubredditChip } from "@/components/SubredditChip";
import { REASON_CATEGORY_LABELS } from "@/lib/competitors/classify";
import type { ReasonGroup } from "@/lib/competitors/read";
import { relativeAge } from "@/lib/format";

type CompetitorDislikeViewProps = {
  groups: ReasonGroup[];
  domains: Record<string, string | null>;
};

export function CompetitorDislikeView({ groups, domains }: CompetitorDislikeViewProps) {
  if (groups.length === 0) {
    return (
      <EmptyState
        title="No concrete complaints captured yet"
        sentence="When Reddit users complain about specific limitations or pricing of your competitors, they will appear here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2.5 rounded-card border border-rose-500/20 bg-rose-500/5 p-4 text-small text-fg-muted">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-rose-500" aria-hidden="true" />
        <div>
          <span className="font-medium text-fg">Evidence Boundary: </span>
          These findings represent reported user frustration and product limitations from public Reddit posts.
          They do not prove customer churn or verify vendor revenue loss.
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {groups.map((group) => {
          const categoryLabel = REASON_CATEGORY_LABELS[group.reasonCategory] ?? group.reasonCategory;
          const key = `${group.competitor}::${group.reasonCategory}`;

          return (
            <div key={key} className="flex flex-col gap-3 rounded-card border bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <CompetitorChip name={group.competitor} domain={domains[group.competitor] ?? null} />
                  <span className="rounded-control bg-rose-500/10 px-2.5 py-0.5 text-small font-medium text-rose-600 dark:text-rose-400">
                    {categoryLabel}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {group.isRecurring ? (
                    <span className="rounded-control border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-mono text-rose-600 dark:text-rose-400">
                      Recurring complaint ({group.distinctThreads} threads)
                    </span>
                  ) : (
                    <span className="rounded-control border border-dashed border-fg-muted/30 px-2 py-0.5 text-mono text-fg-muted">
                      Single observation (example)
                    </span>
                  )}
                </div>
              </div>

              <p className="text-body text-fg" style={{ fontWeight: 500 }}>
                {group.representativeExplanation}
              </p>

              <details className="group rounded-card bg-surface-2 p-3">
                <summary className="flex cursor-pointer items-center justify-between text-small font-medium text-fg-muted hover:text-fg">
                  <span>
                    Inspect supporting evidence ({group.distinctThreads} {group.distinctThreads === 1 ? "thread" : "threads"}
                    {group.totalMentions > group.distinctThreads ? `, ${group.totalMentions} mentions` : ""})
                  </span>
                  <ChevronDown className="size-4 transition-transform duration-200 group-open:rotate-180" aria-hidden="true" />
                </summary>

                <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
                  {group.mentions.map((mention) => (
                    <div key={mention.id} className="flex flex-col gap-2 rounded-control bg-surface p-3 text-small">
                      <div className="flex flex-wrap items-center gap-2 text-fg-muted">
                        <AuthorAvatar name={mention.author} src={mention.avatarUrl} size={20} />
                        <span className="font-medium text-fg">u/{mention.author ?? "unknown"}</span>
                        <SubredditChip name={mention.subreddit} iconUrl={mention.subredditIconUrl} />
                        <span className="text-mono">{relativeAge(mention.createdAt)}</span>
                      </div>

                      <a
                        href={mention.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 font-medium text-fg hover:text-fg-muted hover:underline"
                      >
                        <span>{mention.title}</span>
                        <ExternalLink className="size-3 text-fg-muted" aria-hidden="true" />
                      </a>

                      {mention.quote ? (
                        <blockquote className="border-l-2 border-rose-500/40 pl-2.5 text-fg-muted italic">
                          &ldquo;{mention.quote}&rdquo;
                        </blockquote>
                      ) : mention.explanation ? (
                        <p className="text-fg-muted">{mention.explanation}</p>
                      ) : mention.summary ? (
                        <p className="text-fg-muted">{mention.summary}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </details>
            </div>
          );
        })}
      </div>
    </div>
  );
}
