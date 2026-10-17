import Link from "next/link";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Globe,
  HelpCircle,
  RotateCcw,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import {
  confirmDemandPageMappingAction,
  inspectWebsiteAction,
} from "@/app/app/insights/actions";
import { relativeAge } from "@/lib/format";
import type { DemandGapCandidate, WebsiteInspectionSnapshot } from "@/lib/gaps";

type DemandGapsViewProps = {
  projectId: string;
  projectUrl: string | null;
  candidates: DemandGapCandidate[];
  inspection: WebsiteInspectionSnapshot;
  hasLeads: boolean;
};

function priorityBadgeClass(priority: DemandGapCandidate["priority"]): string {
  switch (priority) {
    case "high":
      return "border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-400";
    case "medium":
      return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-400";
    case "developing":
      return "border-border bg-surface-2 text-fg-muted";
    case "addressed":
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-400";
  }
}

function priorityLabel(priority: DemandGapCandidate["priority"]): string {
  switch (priority) {
    case "high":
      return "High priority gap";
    case "medium":
      return "Medium priority gap";
    case "developing":
      return "Developing evidence";
    case "addressed":
      return "Covered / Addressed";
  }
}

export function DemandGapsView({
  projectId,
  projectUrl,
  candidates,
  inspection,
  hasLeads,
}: DemandGapsViewProps) {
  if (!hasLeads) {
    return (
      <EmptyState
        title="No buyer conversations yet"
        sentence="Run a discovery scan and record lead outcomes to uncover demand-to-page opportunities."
      />
    );
  }

  const highGaps = candidates.filter((c) => c.priority === "high");
  const confirmedGaps = candidates.filter((c) => c.confirmation.status === "confirmed_gap");
  const addressed = candidates.filter((c) => c.priority === "addressed");

  return (
    <div className="flex flex-col gap-6">
      {/* Overview and Website Inspection Trigger */}
      <div className="rounded-card border bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-h3 font-medium">Demand-to-page gap analysis</h2>
            <p className="text-small text-fg-muted">
              Connect the problems people discuss to the pages on your website that address them.
            </p>
            {projectUrl ? (
              <p className="text-small text-fg-muted">
                Configured site:{" "}
                <a
                  href={projectUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-medium underline hover:text-fg"
                >
                  {projectUrl}
                </a>
              </p>
            ) : (
              <p className="text-small text-amber-700">
                No website URL configured. Configure your website in Product to inspect page coverage.
              </p>
            )}
          </div>
          {projectUrl && (
            <form action={inspectWebsiteAction.bind(null, projectId)}>
              <button
                type="submit"
                className="inline-flex items-center gap-2 rounded-control bg-brand px-3 py-1.5 text-small font-medium text-white transition hover:bg-brand-hover"
              >
                <Globe className="size-4" aria-hidden="true" />
                {inspection.status === "not_inspected"
                  ? "Inspect website coverage"
                  : "Re-inspect website"}
              </button>
            </form>
          )}
        </div>

        {/* Inspection Status or Error Banner */}
        <div className="mt-3 text-small">
          {inspection.error && (
            <div className="mb-3 flex items-start gap-2 rounded-control border border-amber-200 bg-amber-50 p-2.5 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
              <span>
                <strong>Last inspection warning:</strong> {inspection.error}. Showing pages from
                previous successful inspection.
              </span>
            </div>
          )}

          {inspection.status === "success" || inspection.status === "partial" ? (
            <div className="flex items-center gap-2 text-fg-muted">
              <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" />
              <span>
                Last inspected{" "}
                {inspection.inspectedAt
                  ? relativeAge(new Date(inspection.inspectedAt))
                  : "recently"}{" "}
                ({inspection.pagesCount} pages indexed).
              </span>
            </div>
          ) : inspection.status === "failed" ? (
            <div className="flex items-center gap-2 text-red-600">
              <AlertCircle className="size-4" aria-hidden="true" />
              <span>Website inspection failed: {inspection.error || "Unable to inspect website"}.</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-fg-muted">
              <HelpCircle className="size-4" aria-hidden="true" />
              <span>Website not yet inspected. Click &quot;Inspect website coverage&quot; to index your site pages.</span>
            </div>
          )}
        </div>

        {/* Metrics Strip */}
        <div className="grid grid-cols-2 gap-4 border-t pt-4 sm:grid-cols-4">
          <div className="flex flex-col gap-1">
            <span className="text-mono text-fg-muted uppercase">Demand topics</span>
            <span className="text-h2 font-medium tabular-nums">{candidates.length}</span>
            <span className="text-small text-fg-muted">Observed buyer needs</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-mono text-fg-muted uppercase">High priority gaps</span>
            <span className="text-h2 font-medium tabular-nums text-red-600">{highGaps.length}</span>
            <span className="text-small text-fg-muted">Multiple leads or sales</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-mono text-fg-muted uppercase">Confirmed gaps</span>
            <span className="text-h2 font-medium tabular-nums text-amber-600">
              {confirmedGaps.length}
            </span>
            <span className="text-small text-fg-muted">Verified by founder</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-mono text-fg-muted uppercase">Covered / Addressed</span>
            <span className="text-h2 font-medium tabular-nums text-emerald-600">
              {addressed.length}
            </span>
            <span className="text-small text-fg-muted">Matching pages confirmed</span>
          </div>
        </div>
      </div>

      {/* Candidate Gaps List */}
      {candidates.length === 0 ? (
        <EmptyState
          title="No demand gaps identified"
          sentence="Record outcomes and run website inspection to uncover demand gaps."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {candidates.map((candidate) => {
            const hasMatch = Boolean(candidate.pageCoverage.bestPageUrl);
            return (
              <div
                key={candidate.id}
                className="flex flex-col gap-4 rounded-card border bg-surface p-5"
              >
                {/* Header row */}
                <div className="flex flex-wrap items-baseline justify-between gap-3 border-b pb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-h3 font-medium">{candidate.label}</h3>
                    <span
                      className={`inline-flex items-center rounded-control border px-2 py-0.5 text-mono font-medium ${priorityBadgeClass(
                        candidate.priority,
                      )}`}
                    >
                      {priorityLabel(candidate.priority)}
                    </span>
                    <span className="text-small text-fg-muted">
                      ({candidate.threadCount} conversation
                      {candidate.threadCount === 1 ? "" : "s"})
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-small">
                    <Link
                      href={`/app/leads?project=${projectId}`}
                      className="inline-flex items-center gap-1 font-medium text-brand hover:underline"
                    >
                      <span>Inspect leads in Feed</span>
                      <ArrowRight className="size-3.5" aria-hidden="true" />
                    </Link>
                    {candidate.pageCoverage.bestPageUrl && (
                      <a
                        href={candidate.pageCoverage.bestPageUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 text-fg-muted hover:text-fg hover:underline"
                      >
                        <span>View page</span>
                        <ExternalLink className="size-3.5" aria-hidden="true" />
                      </a>
                    )}
                  </div>
                </div>

                {/* Priority Reason */}
                <div className="rounded-control border bg-surface-2 p-3 text-small">
                  <strong>Priority evaluation:</strong> {candidate.priorityReason}
                </div>

                {/* Three-part Evidence Box */}
                <div className="grid gap-4 md:grid-cols-3">
                  {/* 1. What we observed */}
                  <div className="flex flex-col gap-2 rounded-control border bg-surface-2 p-3.5">
                    <span className="text-mono font-medium text-fg-muted uppercase">
                      1. What we observed
                    </span>
                    <p className="text-small text-fg">{candidate.explanation.observed}</p>

                    {/* Supporting thread excerpts */}
                    <div className="mt-2 flex flex-col gap-1.5 border-t pt-2">
                      <span className="text-mono text-fg-muted">Supporting conversations:</span>
                      {candidate.supportingThreads.slice(0, 2).map((thread) => (
                        <div key={thread.postId} className="text-small">
                          <a
                            href={thread.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 font-medium text-fg hover:text-brand hover:underline"
                          >
                            <span className="text-mono text-fg-muted">r/{thread.subreddit}:</span>
                            <span className="line-clamp-1">{thread.title}</span>
                            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                          </a>
                          {thread.excerpt && (
                            <p className="line-clamp-2 text-fg-muted italic text-[13px]">
                              &quot;{thread.excerpt}&quot;
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 2. Why it may matter */}
                  <div className="flex flex-col gap-2 rounded-control border bg-surface-2 p-3.5">
                    <span className="text-mono font-medium text-fg-muted uppercase">
                      2. Why it may matter
                    </span>
                    <p className="text-small text-fg">{candidate.explanation.whyItMatters}</p>

                    {hasMatch ? (
                      <div className="mt-2 flex flex-col gap-1 border-t pt-2 text-small">
                        <span className="text-mono text-fg-muted">Candidate page:</span>
                        <a
                          href={candidate.pageCoverage.bestPageUrl!}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="font-medium text-brand hover:underline"
                        >
                          {candidate.pageCoverage.bestPageTitle || candidate.pageCoverage.bestPageUrl}
                        </a>
                        {candidate.pageCoverage.matchedTerms.length > 0 && (
                          <span className="text-mono text-fg-muted text-[12px]">
                            Matched terms: {candidate.pageCoverage.matchedTerms.join(", ")}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="mt-2 border-t pt-2 text-small text-fg-muted">
                        No clear matching page identified among indexed pages.
                      </div>
                    )}
                  </div>

                  {/* 3. What needs confirmation */}
                  <div className="flex flex-col gap-2 rounded-control border bg-surface-2 p-3.5">
                    <span className="text-mono font-medium text-fg-muted uppercase">
                      3. What needs confirmation
                    </span>
                    <p className="text-small text-fg">{candidate.explanation.needsConfirmation}</p>

                    {/* Interactive confirmation actions */}
                    <div className="mt-auto flex flex-wrap gap-1.5 border-t pt-3">
                      {hasMatch && candidate.confirmation.status !== "confirmed_match" && (
                        <form
                          action={confirmDemandPageMappingAction.bind(
                            null,
                            projectId,
                            candidate.id,
                            "confirmed_match",
                            candidate.pageCoverage.bestPageUrl,
                            null,
                          )}
                        >
                          <button
                            type="submit"
                            className="inline-flex items-center gap-1 rounded-control border border-emerald-300 bg-emerald-50 px-2 py-1 text-mono text-emerald-800 transition hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
                          >
                            <CheckCircle2 className="size-3" aria-hidden="true" />
                            <span>Confirm match</span>
                          </button>
                        </form>
                      )}

                      {candidate.confirmation.status !== "confirmed_gap" && (
                        <form
                          action={confirmDemandPageMappingAction.bind(
                            null,
                            projectId,
                            candidate.id,
                            "confirmed_gap",
                            null,
                            null,
                          )}
                        >
                          <button
                            type="submit"
                            className="inline-flex items-center gap-1 rounded-control border border-red-300 bg-red-50 px-2 py-1 text-mono text-red-800 transition hover:bg-red-100 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300"
                          >
                            <AlertCircle className="size-3" aria-hidden="true" />
                            <span>Confirm gap</span>
                          </button>
                        </form>
                      )}

                      {hasMatch && candidate.confirmation.status !== "partial_match" && (
                        <form
                          action={confirmDemandPageMappingAction.bind(
                            null,
                            projectId,
                            candidate.id,
                            "partial_match",
                            candidate.pageCoverage.bestPageUrl,
                            null,
                          )}
                        >
                          <button
                            type="submit"
                            className="inline-flex items-center gap-1 rounded-control border border-amber-300 bg-amber-50 px-2 py-1 text-mono text-amber-800 transition hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
                          >
                            <HelpCircle className="size-3" aria-hidden="true" />
                            <span>Mark partial</span>
                          </button>
                        </form>
                      )}

                      {candidate.confirmation.status !== "unconfirmed" && (
                        <form
                          action={confirmDemandPageMappingAction.bind(
                            null,
                            projectId,
                            candidate.id,
                            "unconfirmed",
                            null,
                            null,
                          )}
                        >
                          <button
                            type="submit"
                            className="inline-flex items-center gap-1 rounded-control border px-2 py-1 text-mono text-fg-muted transition hover:bg-surface-3"
                          >
                            <RotateCcw className="size-3" aria-hidden="true" />
                            <span>Reset</span>
                          </button>
                        </form>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
