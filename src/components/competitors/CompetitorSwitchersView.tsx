import { ArrowRightLeft, ExternalLink, Sparkles } from "lucide-react";
import { AuthorAvatar } from "@/components/AuthorAvatar";
import { CompetitorChip } from "@/components/competitors/CompetitorChip";
import { EmptyState } from "@/components/EmptyState";
import { SubredditChip } from "@/components/SubredditChip";
import { REASON_CATEGORY_LABELS, SWITCHING_EVIDENCE_LABELS } from "@/lib/competitors/classify";
import type { SwitcherOpportunity } from "@/lib/competitors/read";
import { relativeAge } from "@/lib/format";

type CompetitorSwitchersViewProps = {
  switchers: SwitcherOpportunity[];
  domains: Record<string, string | null>;
};

export function CompetitorSwitchersView({ switchers, domains }: CompetitorSwitchersViewProps) {
  if (switchers.length === 0) {
    return (
      <EmptyState
        title="No potential switchers identified yet"
        sentence="When Reddit users explicitly discuss leaving a competitor or ask for alternatives, they will be highlighted here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2.5 rounded-card border border-amber-500/20 bg-amber-500/5 p-4 text-small text-fg-muted">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
        <div>
          <span className="font-medium text-fg">High Commercial Immediacy: </span>
          These conversations feature authors explicitly stating they are migrating away from a competitor or actively evaluating alternatives.
          General negative complaints without explicit switching intent are excluded.
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {switchers.map((switcher) => {
          const isActivelySwitching = switcher.signal === "actively_switching";
          const signalLabel = SWITCHING_EVIDENCE_LABELS[switcher.signal] ?? switcher.signal;
          const categoryLabel = REASON_CATEGORY_LABELS[switcher.reasonCategory] ?? switcher.reasonCategory;

          return (
            <div key={switcher.id} className="flex flex-col gap-3 rounded-card border bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <CompetitorChip name={switcher.competitor} domain={domains[switcher.competitor] ?? null} />
                  <span
                    className={
                      isActivelySwitching
                        ? "inline-flex items-center gap-1 rounded-control border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-small font-medium text-amber-600 dark:text-amber-400"
                        : "inline-flex items-center gap-1 rounded-control border border-blue-500/30 bg-blue-500/10 px-2.5 py-0.5 text-small font-medium text-blue-600 dark:text-blue-400"
                    }
                  >
                    <ArrowRightLeft className="size-3.5" aria-hidden="true" />
                    {signalLabel}
                  </span>
                  <span className="rounded-control bg-surface-2 px-2 py-0.5 text-small text-fg-muted">
                    {categoryLabel}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-mono text-fg-muted">
                  <span>{relativeAge(switcher.createdAt)}</span>
                </div>
              </div>

              <a
                href={switcher.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1.5 text-h3 text-fg hover:text-fg-muted hover:underline"
                style={{ fontWeight: 500 }}
              >
                <span>{switcher.title}</span>
                <ExternalLink className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
              </a>

              {switcher.explanation ? (
                <p className="text-body text-fg" style={{ fontWeight: 500 }}>
                  {switcher.explanation}
                </p>
              ) : null}

              {switcher.quoteOrSummary ? (
                <blockquote className="rounded-card bg-surface-2 p-3 text-small text-fg-muted italic">
                  &ldquo;{switcher.quoteOrSummary}&rdquo;
                </blockquote>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-small text-fg-muted">
                <div className="flex flex-wrap items-center gap-2">
                  <AuthorAvatar name={switcher.author} src={switcher.avatarUrl} size={20} />
                  <span className="font-medium text-fg">u/{switcher.author ?? "unknown"}</span>
                  <SubredditChip name={switcher.subreddit} iconUrl={switcher.subredditIconUrl} />
                </div>
                <div className="text-mono">
                  {switcher.allMentionsInThread.length > 1
                    ? `${switcher.allMentionsInThread.length} mentions in conversation`
                    : "1 conversation thread"}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
