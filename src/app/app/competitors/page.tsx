import { openCompetitorsAction, scanCompetitorsAction } from "@/app/app/jobs";
import { StartOnOpen } from "@/components/StartOnOpen";
import { CompetitorDislikeView } from "@/components/competitors/CompetitorDislikeView";
import { CompetitorLoveView } from "@/components/competitors/CompetitorLoveView";
import { CompetitorSwitchersView } from "@/components/competitors/CompetitorSwitchersView";
import { CompetitorTabs, type CompetitorTab } from "@/components/competitors/CompetitorTabs";
import { MentionCard } from "@/components/competitors/MentionCard";
import { MentionsBar } from "@/components/competitors/MentionsBar";
import { TopCompetitors } from "@/components/competitors/TopCompetitors";
import { EmptyState } from "@/components/EmptyState";
import { JobStatus, type JobWords } from "@/components/JobStatus";
import { lastRunJob, nextQueuedJob } from "@/jobs/enqueue";
import { requireLocalUser } from "@/lib/auth";
import { allowanceFor } from "@/lib/throttle";
import { PaidButton } from "@/components/PaidButton";
import {
  domainsByName,
  groupDislikeReasons,
  groupLoveReasons,
  listMentions,
  listPotentialSwitchers,
  mentionSeries,
  topCompetitors,
  watchedCompetitors,
} from "@/lib/competitors/read";
import { requireActiveProject } from "@/lib/projects";
import { getSourcePolicy } from "@/lib/sourcePolicy";

type CompetitorsPageProps = { searchParams: Promise<{ project?: string; tab?: string }> };

/** The competitor scan's status line. */
const SCAN_WORDS: JobWords = {
  noun: "scan",
  running: "Scanning now",
  finished: (_job, ago) => `Last scanned ${ago}.`,
  stopped: "Last scan stopped",
  never: "No competitor scan has run yet.",
  button: "Scan now",
};

export default async function CompetitorsPage({ searchParams }: CompetitorsPageProps) {
  const user = await requireLocalUser();
  const params = await searchParams;
  const project = await requireActiveProject(user.id, params.project);

  const tab: CompetitorTab =
    params.tab === "dislike"
      ? "dislike"
      : params.tab === "switchers"
        ? "switchers"
        : params.tab === "mentions"
          ? "mentions"
          : "love";

  const [competitors, mentions, last, next, allowance] = await Promise.all([
    watchedCompetitors(project.id),
    listMentions(project.id),
    lastRunJob("competitor_scan", project.id),
    nextQueuedJob("competitor_scan", project.id),
    allowanceFor(user.id, "competitor_scan"),
  ]);
  const names = competitors.map((row) => row.name);
  const domains = domainsByName(competitors);
  const ranked = topCompetitors(mentions);

  const loveReasons = groupLoveReasons(mentions);
  const dislikeReasons = groupDislikeReasons(mentions);
  const switchers = listPotentialSwitchers(mentions);

  const counts = {
    love: loveReasons.length,
    dislike: dislikeReasons.length,
    switchers: switchers.length,
    mentions: mentions.length,
  };

  const redditPolicy = getSourcePolicy("reddit");

  // Keyed so switching projects mounts StartOnOpen again for the new one.
  return (
    <div key={project.id} className="flex flex-col gap-5">
      {last ? null : <StartOnOpen start={openCompetitorsAction.bind(null, project.id)} />}
      {!redditPolicy.enabled ? (
        <div className="rounded-card border border-warning/40 bg-warning/10 p-4 text-small">
          <p style={{ fontWeight: 500 }} className="text-warning">
            Reddit Source Access Disabled
          </p>
          <p className="mt-1 text-fg-muted">{redditPolicy.reason}</p>
          <p className="mt-2 text-fg-muted">
            Competitor mentions and switching evidence derived from Reddit are paused until
            valid commercial authorization is recorded.
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-h2" style={{ fontWeight: 500 }}>
            Competitors
          </h1>
          <JobStatus last={last} next={next} words={SCAN_WORDS} />
        </div>
        <form action={scanCompetitorsAction.bind(null, project.id)}>
          <PaidButton label="Scan now" allowance={allowance} />
        </form>
      </div>

      {names.length === 0 ? (
        <EmptyState
          title="No competitors yet"
          sentence="Add the products you compete with on the Product screen, then scan for what Reddit says about them."
        />
      ) : !redditPolicy.enabled ? (
        <EmptyState
          title="Reddit source disabled"
          sentence="Commercial access to Reddit data is not authorized. Mentions, praise, limitations, and switcher signals cannot be displayed."
        />
      ) : (
        <>
          {ranked.length > 0 ? <TopCompetitors rows={ranked} domains={domains} /> : null}
          <MentionsBar series={mentionSeries(mentions, names)} />

          <CompetitorTabs active={tab} projectId={project.id} counts={counts} />

          {tab === "love" ? (
            <CompetitorLoveView groups={loveReasons} domains={domains} />
          ) : tab === "dislike" ? (
            <CompetitorDislikeView groups={dislikeReasons} domains={domains} />
          ) : tab === "switchers" ? (
            <CompetitorSwitchersView switchers={switchers} domains={domains} />
          ) : mentions.length === 0 ? (
            <EmptyState
              title="No mentions yet"
              sentence="Nothing on Reddit named these products in the last 30 days, or no scan has run."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {mentions.map((mention) => (
                <MentionCard key={mention.id} mention={mention} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
