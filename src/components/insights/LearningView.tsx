import Link from "next/link";
import { ArrowRight, CheckCircle2, AlertTriangle, HelpCircle, Sparkles } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { applyCommunitySuggestionAction } from "@/app/app/insights/actions";
import { communityKey, type ScoringSettings } from "@/lib/scoring/weights";
import type { OutcomeLearningSnapshot } from "@/lib/learning";

type LearningViewProps = {
  projectId: string;
  snapshot: OutcomeLearningSnapshot;
  scoring: ScoringSettings | null;
};

function leadsFilterHref(
  projectId: string,
  dimension: "community" | "stage" | "kind",
  value: string,
  status?: string,
): string {
  const params = new URLSearchParams({ project: projectId });
  if (dimension === "community") {
    params.set("subreddit", value.toLowerCase());
  } else if (dimension === "stage") {
    params.set("stage", value);
  }
  if (status) {
    params.set("status", status);
  }
  return `/app/leads?${params.toString()}`;
}

export function LearningView({ projectId, snapshot, scoring }: LearningViewProps) {
  if (snapshot.labelledLeadCount === 0) {
    return (
      <EmptyState
        title="No outcome patterns yet"
        sentence="As you record confirmed outcomes on leads (Replied, Meeting booked, Opportunity, Customer, Not a fit), Leystic identifies recurring commercial patterns to help prioritize future opportunities."
      />
    );
  }

  const promising = snapshot.patterns.filter((p) => p.status === "promising");
  const mismatches = snapshot.patterns.filter((p) => p.status === "repeated_mismatch");
  const developing = snapshot.patterns.filter(
    (p) => p.status === "mixed" || p.status === "insufficient_evidence",
  );

  const favouredCommunities = new Set((scoring?.communities ?? []).map(communityKey));

  return (
    <div className="flex flex-col gap-6">
      {/* What Leystic has learned - Overview metrics */}
      <div className="rounded-card border bg-surface p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-3">
          <div>
            <h2 className="text-h3 font-medium">Outcome learning overview</h2>
            <p className="text-small text-fg-muted">
              First-party lessons derived from your recorded founder outcomes.
            </p>
          </div>
          <div className="text-small text-mono text-fg-muted">
            Scope: Analyzed up to {snapshot.sampleLimit} recent outcomes ({snapshot.totalSampled} sampled)
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-4">
          <div className="flex flex-col gap-1">
            <span className="text-mono text-fg-muted uppercase">Labelled leads</span>
            <span className="text-h2 font-medium tabular-nums">{snapshot.labelledLeadCount}</span>
            <span className="text-small text-fg-muted">Confirmed by founder</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-mono text-fg-muted uppercase">Qualified progress</span>
            <span className="text-h2 font-medium tabular-nums text-brand">
              {snapshot.qualifiedProgressCount}
            </span>
            <span className="text-small text-fg-muted">
              {snapshot.meetingBookedCount} meetings, {snapshot.opportunityCount} opps, {snapshot.customerCount} customers
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-mono text-fg-muted uppercase">Replies</span>
            <span className="text-h2 font-medium tabular-nums">{snapshot.engagementCount}</span>
            <span className="text-small text-fg-muted">Founder engagements</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-mono text-fg-muted uppercase">Not a fit</span>
            <span className="text-h2 font-medium tabular-nums">{snapshot.notFitCount}</span>
            <span className="text-small text-fg-muted">Explicit mismatches</span>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-control border bg-surface-2 p-3 text-small">
          {snapshot.enoughEvidenceToPrioritize ? (
            <div className="flex items-center gap-2 text-fg">
              <CheckCircle2 className="size-4 shrink-0 text-brand" aria-hidden="true" />
              <span>
                <strong>Learned prioritization is active:</strong> Sufficient evidence (5+ labelled leads and 5+ terminal outcomes) enables learned feed ordering.
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-fg-muted">
              <Sparkles className="size-4 shrink-0" aria-hidden="true" />
              <span>
                <strong>Prioritization threshold:</strong> Learned priority unlocks at 5 labelled leads and 5 terminal outcomes (currently {snapshot.labelledLeadCount}/5 labelled, {snapshot.terminalOutcomeCount}/5 terminal outcomes).
              </span>
            </div>
          )}
          {snapshot.enoughEvidenceToPrioritize ? (
            <Link
              href={`/app/leads?project=${projectId}&order=learned`}
              className="inline-flex items-center gap-1 font-medium text-brand underline"
            >
              View feed with Learned priority
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          ) : null}
        </div>
      </div>

      {/* Patterns with positive evidence */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-4 text-brand" aria-hidden="true" />
          <h2 className="text-h3 font-medium">Patterns with positive evidence</h2>
        </div>
        <p className="text-small text-fg-muted">
          Dimensions with at least 4 recorded terminal outcomes where qualified progress is 2 or more and exceeds mismatches.
        </p>

        {promising.length === 0 ? (
          <div className="rounded-card border bg-surface p-4 text-small text-fg-muted">
            No patterns have met the positive evidence threshold yet (requires at least 4 terminal outcomes with 2+ qualified-progress outcomes exceeding not-fit).
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {promising.map((pattern) => {
              const dimLabel = pattern.dimension === "community" ? `r/${pattern.value}` : pattern.value;
              const isFavoured =
                pattern.dimension === "community" && favouredCommunities.has(pattern.value.toLowerCase());

              return (
                <div
                  key={`${pattern.dimension}-${pattern.value}`}
                  className="flex flex-col justify-between gap-3 rounded-card border bg-surface p-4"
                >
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-fg">{dimLabel}</span>
                      <span className="rounded-control bg-brand-soft px-2 py-0.5 text-mono text-brand">
                        Promising signal
                      </span>
                    </div>
                    <p className="text-small text-fg">
                      {pattern.qualifiedProgressCount} qualified-progress outcome
                      {pattern.qualifiedProgressCount === 1 ? "" : "s"} ({pattern.meetingBookedCount} meeting
                      {pattern.meetingBookedCount === 1 ? "" : "s"}, {pattern.opportunityCount} opp
                      {pattern.opportunityCount === 1 ? "" : "s"}, {pattern.customerCount} customer
                      {pattern.customerCount === 1 ? "" : "s"}) and {pattern.notFitCount} marked not a fit
                      among {pattern.terminalOutcomeCount} recorded terminal outcomes.
                    </p>
                    {pattern.engagementCount > 0 ? (
                      <p className="text-small text-fg-muted">
                        Plus {pattern.engagementCount} founder reply without commercial qualification.
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                    <Link
                      href={leadsFilterHref(projectId, pattern.dimension, pattern.value)}
                      className="text-small inline-flex items-center gap-1 text-brand underline"
                    >
                      Inspect {pattern.supportingLeadIds.length} lead
                      {pattern.supportingLeadIds.length === 1 ? "" : "s"} in feed
                      <ArrowRight className="size-3" aria-hidden="true" />
                    </Link>

                    {pattern.dimension === "community" && !isFavoured ? (
                      <form action={applyCommunitySuggestionAction.bind(null, projectId, pattern.value)}>
                        <button
                          type="submit"
                          className="rounded-control border bg-surface-2 px-2.5 py-1 text-small text-fg hover:bg-surface"
                        >
                          Favour in scoring preferences
                        </button>
                      </form>
                    ) : pattern.dimension === "community" ? (
                      <span className="text-small text-fg-muted">Favoured in scoring</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Repeated mismatches */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-reddit" aria-hidden="true" />
          <h2 className="text-h3 font-medium">Repeated mismatches</h2>
        </div>
        <p className="text-small text-fg-muted">
          Dimensions with at least 3 leads marked not a fit and 0 qualified-progress outcomes. These leads are deprioritized when Learned priority is enabled, but never hidden automatically.
        </p>

        {mismatches.length === 0 ? (
          <div className="rounded-card border bg-surface p-4 text-small text-fg-muted">
            No repeated mismatch patterns detected.
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {mismatches.map((pattern) => {
              const dimLabel = pattern.dimension === "community" ? `r/${pattern.value}` : pattern.value;

              return (
                <div
                  key={`${pattern.dimension}-${pattern.value}`}
                  className="flex flex-col justify-between gap-3 rounded-card border bg-surface p-4"
                >
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-fg">{dimLabel}</span>
                      <span className="rounded-control bg-surface-2 px-2 py-0.5 text-mono text-fg-muted">
                        Repeated mismatch
                      </span>
                    </div>
                    <p className="text-small text-fg">
                      {pattern.notFitCount} marked not a fit and 0 qualified-progress outcomes among{" "}
                      {pattern.terminalOutcomeCount} recorded terminal outcomes.
                    </p>
                    <p className="text-small text-fg-muted">
                      Leads from this {pattern.dimension} are deprioritized in Learned priority feed order.
                    </p>
                  </div>

                  <div className="border-t pt-3">
                    <Link
                      href={leadsFilterHref(projectId, pattern.dimension, pattern.value, "not_fit")}
                      className="text-small inline-flex items-center gap-1 text-fg-muted underline"
                    >
                      Inspect {pattern.notFitCount} not-fit record
                      {pattern.notFitCount === 1 ? "" : "s"}
                      <ArrowRight className="size-3" aria-hidden="true" />
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Mixed or developing evidence */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <HelpCircle className="size-4 text-fg-muted" aria-hidden="true" />
          <h2 className="text-h3 font-medium">Developing or mixed evidence</h2>
        </div>
        <p className="text-small text-fg-muted">
          Dimensions where sample sizes are still below the 4 terminal outcome threshold or where outcomes are mixed.
        </p>

        {developing.length === 0 ? (
          <div className="rounded-card border bg-surface p-4 text-small text-fg-muted">
            No developing or mixed patterns currently observed.
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {developing.map((pattern) => {
              const dimLabel = pattern.dimension === "community" ? `r/${pattern.value}` : pattern.value;
              const reason =
                pattern.status === "mixed"
                  ? "Recorded terminal outcomes are mixed; continuing to collect evidence."
                  : `Sample too small (${pattern.terminalOutcomeCount}/4 terminal outcomes needed for category classification).`;

              return (
                <div
                  key={`${pattern.dimension}-${pattern.value}`}
                  className="flex flex-col justify-between gap-3 rounded-card border bg-surface p-4"
                >
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-fg">{dimLabel}</span>
                      <span className="rounded-control bg-surface-2 px-2 py-0.5 text-mono text-fg-muted">
                        {pattern.status === "mixed" ? "Mixed evidence" : "Developing"}
                      </span>
                    </div>
                    <p className="text-small text-fg-muted">
                      {pattern.qualifiedProgressCount} qualified progress, {pattern.engagementCount} replies, {pattern.notFitCount} not a fit.
                    </p>
                    <p className="text-small text-fg-muted">{reason}</p>
                  </div>

                  <div className="border-t pt-3">
                    <Link
                      href={leadsFilterHref(projectId, pattern.dimension, pattern.value)}
                      className="text-small inline-flex items-center gap-1 text-fg-muted underline"
                    >
                      Inspect records in feed
                      <ArrowRight className="size-3" aria-hidden="true" />
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
