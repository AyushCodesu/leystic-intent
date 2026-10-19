import { openSeoAction, refreshSeoAction } from "@/app/app/jobs";
import { EmptyState } from "@/components/EmptyState";
import { JobStatus, type JobWords } from "@/components/JobStatus";
import { StartOnOpen } from "@/components/StartOnOpen";
import { NoPhrasings } from "@/components/seo/NoPhrasings";
import { SeoFilters } from "@/components/seo/SeoFilters";
import { SplitView } from "@/components/seo/SplitView";
import { ThreadTable } from "@/components/seo/ThreadTable";
import { lastRunJob, nextQueuedJob } from "@/jobs/enqueue";
import { requireLocalUser } from "@/lib/auth";
import { allowanceFor } from "@/lib/throttle";
import { PaidButton } from "@/components/PaidButton";
import { watchedCompetitors } from "@/lib/competitors/read";
import { requireActiveProject } from "@/lib/projects";
import { listOpportunities, NO_PHRASINGS_PROGRESS, seoFacets, toThread } from "@/lib/seo/read";
import { scoreThreads } from "@/lib/seo/score";
import { orderThreads, seoOrder, seoView, worthReplying, type SeoOrder } from "@/lib/seo/views";
import { getSourcePolicy } from "@/lib/sourcePolicy";
import { withParams } from "@/lib/url";

type SeoParams = {
  project?: string;
  keyword?: string;
  subreddit?: string;
  competitor?: string;
  closed?: string;
  view?: string;
  order?: string;
  /** The thread the list-and-thread view is showing. */
  thread?: string;
};

type SeoPageProps = { searchParams: Promise<SeoParams> };

/** The refresh's status line. One with no phrasing to look up finished without searching. */
const REFRESH_WORDS: JobWords = {
  noun: "refresh",
  running: "Refreshing now",
  finished: (job, ago) =>
    job.progress === NO_PHRASINGS_PROGRESS
      ? `The last refresh, ${ago}, had nothing to look up.`
      : `Last refresh finished ${ago}.`,
  stopped: "Last refresh stopped",
  never: "No refresh has run yet.",
  button: "Refresh now",
};

const EMPTY_SENTENCE =
  "A refresh asks Google which Reddit threads rank for each way your buyers say the problem, then opens every thread for its score, replies and age. At catalog prices the search is about $0.001 per phrasing, and each thread it opens is about $0.001 more.";

/** The same URL with one parameter changed, so a column head or a row is a link. */
function linker(params: SeoParams) {
  return (changes: Partial<Record<string, string | undefined>>): string =>
    `?${withParams(params, changes)}`;
}

/** What the whole tab holds, before any of it is read. */
function tally(phrasings: number, threads: number, strong: number): string {
  return [
    `${phrasings} ${phrasings === 1 ? "phrasing" : "phrasings"}`,
    `${threads} ranking ${threads === 1 ? "thread" : "threads"}`,
    strong > 0 ? `${strong} worth replying in` : "none worth replying in yet",
  ].join(" · ");
}

export default async function SeoPage({ searchParams }: SeoPageProps) {
  const user = await requireLocalUser();
  const params = await searchParams;
  const project = await requireActiveProject(user.id, params.project);

  const view = seoView(params.view);
  const order = seoOrder(params.order);
  const filter = {
    keyword: params.keyword,
    subreddit: params.subreddit,
    competitor: params.competitor,
    closed: params.closed,
  };
  const [rows, facets, last, next, watched, allowance] = await Promise.all([
    listOpportunities(project.id, filter),
    seoFacets(project.id, filter),
    lastRunJob("seo_refresh", project.id),
    nextQueuedJob("seo_refresh", project.id),
    watchedCompetitors(project.id),
    allowanceFor(user.id, "seo_refresh"),
  ]);
  // For naming the competitors a thread mentions. A refresh stores only that
  // some competitor was named, which is the fact worth indexing; which one it
  // was is a plain match on text the page already holds, so it is done here
  // rather than stored twice.
  const competitors = watched.map((row) => row.name);
  const nothingToLookUp = Boolean(last?.finishedAt) && last?.progress === NO_PHRASINGS_PROGRESS;
  // The order is decided here, over the rows in hand, because three of the four
  // orders fold a score the database does not hold. The read's own order is the
  // tiebreak underneath it.
  const threads = orderThreads(scoreThreads(rows.map(toThread)), order);
  const href = linker(params);
  const selected = threads.find((thread) => thread.id === params.thread) ?? threads[0] ?? null;
  const asked = selected !== null && selected.id === params.thread;

  const redditPolicy = getSourcePolicy("reddit");

  // Keyed so switching projects mounts StartOnOpen again for the new one.
  return (
    <div key={project.id} className="flex flex-col gap-5">
      {last ? null : <StartOnOpen start={openSeoAction.bind(null, project.id)} />}
      {!redditPolicy.enabled ? (
        <div className="rounded-card border border-warning/40 bg-warning/10 p-4 text-small">
          <p style={{ fontWeight: 500 }} className="text-warning">
            Reddit Source Data Disabled
          </p>
          <p className="mt-1 text-fg-muted">{redditPolicy.reason}</p>
          <p className="mt-2 text-fg-muted">
            Ranking Reddit thread tracking is paused until commercial authorization is recorded.
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-h2" style={{ fontWeight: 500 }}>
            Reddit SEO
          </h2>
          <JobStatus last={last} next={next} words={REFRESH_WORDS} />
          {threads.length > 0 ? (
            <p className="text-mono text-fg-muted">
              {tally(
                new Set(threads.map((thread) => thread.keyword)).size,
                threads.length,
                threads.filter(worthReplying).length,
              )}
            </p>
          ) : null}
        </div>
        <form action={refreshSeoAction.bind(null, project.id)}>
          <PaidButton label="Refresh now" allowance={allowance} />
        </form>
      </div>
      <SeoFilters facets={facets} />
      {threads.length === 0 ? (
        !redditPolicy.enabled ? (
          <EmptyState
            title="Reddit source disabled"
            sentence="Commercial access to Reddit data is not authorized. Ranking Reddit threads cannot be displayed."
          />
        ) : nothingToLookUp ? (
          <NoPhrasings projectId={project.id} />
        ) : (
          <EmptyState title="Nothing ranked yet" sentence={EMPTY_SENTENCE} />
        )
      ) : (
        <>
          {/* The table is sixty rems of columns, which a phone can only scroll
              sideways through. Below lg both views are the list. */}
          <div className={view === "split" ? undefined : "lg:hidden"}>
            <SplitView
              threads={threads}
              selected={selected}
              asked={asked}
              pane={view === "split" || asked}
              backHref={href({ thread: undefined })}
              hrefFor={(id) => href({ thread: id })}
              competitors={competitors}
            />
          </div>
          {view === "split" ? null : (
            <div className="max-lg:hidden">
              <ThreadTable
                threads={threads}
                order={order}
                hrefFor={(asked: SeoOrder) => href({ order: asked })}
                competitors={competitors}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
