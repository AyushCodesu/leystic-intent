import { AnyapiLink } from "@/components/AnyapiLink";
import { openInsightsAction, refreshInsightsAction } from "@/app/app/jobs";
import { StartOnOpen } from "@/components/StartOnOpen";
import { EmptyState } from "@/components/EmptyState";
import { CommunitiesTable } from "@/components/insights/CommunitiesTable";
import { InsightsTabs, type InsightsTab } from "@/components/insights/InsightsTabs";
import { ThemeCard } from "@/components/insights/ThemeCard";
import { LearningView } from "@/components/insights/LearningView";
import { errorSentence, relativeAge } from "@/lib/format";
import { lastRunJob } from "@/jobs/enqueue";
import { requireLocalUser } from "@/lib/auth";
import { allowanceFor } from "@/lib/throttle";
import { PaidButton } from "@/components/PaidButton";
import { listCommunities, listThemes } from "@/lib/insights/read";
import { getProjectLearningSnapshot } from "@/lib/learning";
import { parseScoring } from "@/lib/scoring/weights";
import { requireActiveProject } from "@/lib/projects";

type InsightsPageProps = { searchParams: Promise<{ project?: string; tab?: string }> };

function lastRunSentence(job: Awaited<ReturnType<typeof lastRunJob>>): string {
  if (!job) {
    return "Nothing grouped yet.";
  }
  if (!job.finishedAt) {
    return job.progress ? `Grouping now: ${job.progress}` : "A grouping is queued.";
  }
  if (job.error) {
    return `Last grouping stopped: ${errorSentence(job.error)}`;
  }
  return `Last grouped ${relativeAge(job.finishedAt)}.`;
}

export default async function InsightsPage({ searchParams }: InsightsPageProps) {
  const user = await requireLocalUser();
  const params = await searchParams;
  const project = await requireActiveProject(user.id, params.project);

  const tab: InsightsTab =
    params.tab === "communities"
      ? "communities"
      : params.tab === "learning"
        ? "learning"
        : "themes";
  const [themes, communities, learningSnapshot, job, allowance] = await Promise.all([
    listThemes(project.id),
    listCommunities(project.id),
    getProjectLearningSnapshot(project.id),
    lastRunJob("insights", project.id),
    allowanceFor(user.id, "insights"),
  ]);

  return (
    <div className="flex flex-col gap-5">
      {/* Keyed so switching projects mounts StartOnOpen again for the new one. */}
      <StartOnOpen key={project.id} start={openInsightsAction.bind(null, project.id)} />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-h2" style={{ fontWeight: 500 }}>
            Insights
          </h1>
          <p className="text-small text-fg-muted">{lastRunSentence(job)}</p>
          <p className="text-small text-fg-muted">
            Themes regroup when you open this page after new leads arrive, and reading them costs
            nothing on <AnyapiLink />.
          </p>
        </div>
        <form action={refreshInsightsAction.bind(null, project.id)}>
          <PaidButton label="Refresh" allowance={allowance} />
        </form>
      </div>
      <InsightsTabs active={tab} projectId={project.id} />
      {tab === "learning" ? (
        <LearningView
          projectId={project.id}
          snapshot={learningSnapshot}
          scoring={parseScoring(project.scoring)}
        />
      ) : tab === "communities" ? (
        <CommunitiesTable rows={communities} />
      ) : themes.length === 0 ? (
        <EmptyState
          title="No themes yet"
          sentence="Once a scan has found leads, they are grouped here by the problem each person describes."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {themes.map((theme) => (
            <ThemeCard key={theme.id} theme={theme} projectId={project.id} />
          ))}
        </div>
      )}
    </div>
  );
}
