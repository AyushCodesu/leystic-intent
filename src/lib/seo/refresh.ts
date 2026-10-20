import { enqueueJob, writeProgress } from "@/jobs/enqueue";
import { clientForUser } from "@/lib/anyapi";
import { labelThreads } from "@/lib/discovery/label";
import {
  applyRelevances,
  loadEvidenceForPosts,
  UNLABELED,
  writeObservations,
} from "@/lib/discovery/store";
import { competitorsInThread, writeThreadMentions } from "@/lib/competitors/threads";
import type { FetchContext } from "@/lib/reddit/fetch";
import { fetchPost } from "@/lib/reddit/skus";
import { ACQUISITION_OPERATIONS } from "@/lib/sourcePolicy";
import type { StoredPost } from "@/lib/reddit/store";
import { commentsAreCurrent, readLeadThreads, storedThreads } from "@/lib/scan/comments";
import { loadEvaluations, writeEvaluations } from "@/lib/scan/evaluations";
import { threadPolicyFor } from "@/lib/settings/threadPolicy";
import type { ThreadPolicy } from "@/lib/settings/types";
import { inFlight } from "@/lib/inFlight";
import { evaluationsFor, judgePosts, unjudged } from "@/lib/scan/judging";
import { requireScanProject, type ScanProject } from "@/lib/scan/project";
import { tierForUser } from "@/lib/tier";
import { googleQuery, googleSearch } from "./fetch";
import { redditThread } from "./links";
import { seoSettings } from "./limits";
import { writeOpportunities, type OpportunityRow } from "./opportunities";
import { NO_PHRASINGS_PROGRESS } from "./read";

const DAY_MS = 24 * 60 * 60 * 1000;

export type SeoRefreshOutcome = {
  phrasings: number;
  threads: number;
  costUsd: number;
};

/**
 * Opens one ranking thread so the page can show its score, replies and age.
 * A thread Reddit will not hand back is skipped: the rest of the phrasing is
 * still worth showing.
 */
async function readThread(
  ctx: FetchContext,
  url: string,
): Promise<{ post: StoredPost | null; costUsd: number }> {
  try {
    const result = await fetchPost(ctx, url, ctx.maxAgeMs, {
      operation: ACQUISITION_OPERATIONS.seo_post,
    });
    return { post: result.value[0] ?? null, costUsd: result.costUsd };
  } catch {
    return { post: null, costUsd: 0 };
  }
}

/**
 * Whether a thread's replies are worth buying: the policy reads replies here
 * at all, there are enough of them to name anyone, and the stored comments are
 * not the thread as Reddit last reported it. The same freshness rule a scan
 * applies to a lead's thread, so a thread both surfaces hold is bought once
 * between them.
 *
 * Age gates nothing here. A thread Google still ranks is worth its replies
 * however old the post is; what earns the call is the ranking, not the clock.
 * When the policy reads no SEO replies, nothing is bought and the competitor
 * flag rests on the post's own text and whatever an earlier read stored.
 *
 * Exported for its own test: the refresh around it needs a funded client.
 */
export function repliesWorthReading(policy: ThreadPolicy, post: StoredPost): boolean {
  return (
    policy.readSeoReplies &&
    (post.numComments ?? 0) >= policy.minReplies &&
    !commentsAreCurrent(post)
  );
}

async function refreshPhrasing(
  project: ScanProject,
  ctx: FetchContext,
  policy: ThreadPolicy,
  phrasing: string,
): Promise<{ threads: number; costUsd: number; seen: Seen[]; opened: StoredPost[] }> {
  const ranked = await googleSearch(ctx, googleQuery(phrasing), { preferLatency: true });
  // The threads are opened together, and what they found is then taken in
  // Google's order, so the result is the same as opening them one by one.
  const reads = await inFlight(ranked.value, (result) => readThread(ctx, result.url));
  let costUsd = ranked.costUsd;
  const seen: Seen[] = [];
  const opened: StoredPost[] = [];
  const positions = new Map<string, number>();
  for (const [index, result] of ranked.value.entries()) {
    const thread = reads[index];
    costUsd += thread.costUsd;
    if (!thread.post) {
      continue;
    }
    opened.push(thread.post);
    positions.set(thread.post.id, result.position);
    seen.push({
      postId: thread.post.id,
      canonicalUrl: redditThread(result.url)?.canonicalUrl ?? result.url,
      subreddit: thread.post.subreddit.toLowerCase(),
      query: googleQuery(phrasing),
      position: result.position,
      title: thread.post.title,
      snippet: result.snippet,
    });
  }
  // Each opened thread with its replies: bought now when they are worth
  // reading, otherwise whatever an earlier read stored, which is what the flag
  // is judged on. Every opened thread is a row on the tab, so one whose
  // replies could not be bought this time falls back to the store as well.
  const read = await readLeadThreads(ctx, opened, (post) => repliesWorthReading(policy, post));
  const got = new Set(read.map((thread) => thread.post.id));
  const threads = [...read, ...(await storedThreads(opened.filter((post) => !got.has(post.id))))];
  await writeThreadMentions(project.id, project.competitors, threads);
  const rows: OpportunityRow[] = threads.map((thread) => ({
    postId: thread.post.id,
    position: positions.get(thread.post.id) as number,
    competitorPresent: competitorsInThread(project.competitors, thread).length > 0,
  }));
  await writeOpportunities(project.id, phrasing, rows);
  return { threads: rows.length, costUsd, seen, opened };
}

/**
 * The project's own judgement of every thread this refresh opened, written the
 * way a scan writes one: the shared product-agnostic reading first, then the
 * judge on whatever that reading left, then a `lead_evaluations` row.
 *
 * It is the same judgement a lead gets, not a second scorer, because the tab
 * orders on it and two scorers would eventually disagree about one person. The
 * text is already bought and in hand, so there is nothing to cap: what a
 * refresh opened is exactly what it judges. The reading is shared across
 * projects, so a thread another project has already read costs nothing here,
 * and a post this project already holds a current verdict on is skipped.
 *
 * It writes no lead. The feed is what a scan found; this only gives the SEO tab
 * something truer to order on than the discovery label.
 */
async function judgeOpened(project: ScanProject, opened: StoredPost[]): Promise<void> {
  const posts = [...new Map(opened.map((post) => [post.id, post])).values()];
  if (posts.length === 0) {
    return;
  }
  const stored = await loadEvaluations(project.id);
  const candidates = unjudged(project, stored, posts);
  if (candidates.length === 0) {
    return;
  }
  const judgements = await judgePosts(project, candidates);
  await writeEvaluations(evaluationsFor(project, candidates, judgements));
}

/** One ranking thread, as discovery files what it has seen of a thread. */
type Seen = {
  postId: string;
  canonicalUrl: string;
  subreddit: string;
  query: string;
  position: number | null;
  title: string;
  snippet: string | null;
};

/**
 * Judges the ranking threads this project has no verdict on yet, against the
 * same product facts and with the same call discovery uses. Most of them need
 * no call at all: discovery and this refresh ask Google the one question, so a
 * phrasing discovery has already asked returns threads it has already judged.
 * What is left is a phrasing the discovery budget never reached, and one call
 * is what stops the page ordering those threads as if nobody had looked.
 *
 * Exported for its own test: the refresh around it needs a funded client and
 * two upstream calls, and what is worth pinning is which threads it pays to
 * judge.
 */
export async function judgeUnseen(project: ScanProject, seen: Seen[]): Promise<void> {
  if (seen.length === 0) {
    return;
  }
  const byPost = new Map(seen.map((thread) => [thread.postId, thread]));
  await writeObservations(
    project.id,
    [...byPost.values()].map((thread) => ({ ...thread, family: null, destination: null })),
  );
  const held = await loadEvidenceForPosts(project.id, [...byPost.keys()]);
  const judged = new Set(
    held.filter((row) => row.relevance !== UNLABELED).map((row) => row.postId),
  );
  const labels = await labelThreads({
    projectId: project.id,
    product: project.product,
    destinations: project.destinations,
    candidates: [...byPost.values()]
      .filter((thread) => !judged.has(thread.postId))
      .map((thread) => ({
        id: thread.postId,
        subreddit: thread.subreddit,
        title: thread.title,
        snippet: thread.snippet ?? "",
      })),
  });
  await applyRelevances(project.id, labels);
}

/**
 * One Reddit SEO refresh: for every problem phrasing the tier allows, which
 * Reddit threads Google ranks, what each thread looks like now, and whether a
 * competitor is named in it or recommended in its replies. It searches the way buyers say the problem, not
 * the plan's Reddit queries, because those are Boolean expressions Google
 * cannot read. Every project books its next refresh on the way out, at its tier's refresh
 * interval, including one with no phrasings yet: a project that booked nothing
 * would never look again once its owner wrote them.
 */
export async function runSeoRefresh(
  projectId: string,
  jobId: string,
): Promise<SeoRefreshOutcome> {
  const project = await requireScanProject(projectId);
  const { limits, settings: scanSettings } = await tierForUser(project.userId);
  const settings = seoSettings(limits, project.phrasings);
  const maxAgeMs = settings.refreshDays * DAY_MS;
  if (settings.phrasings.length === 0) {
    await writeProgress(jobId, NO_PHRASINGS_PROGRESS);
    await enqueueJob("seo_refresh", projectId, new Date(Date.now() + maxAgeMs));
    return { phrasings: 0, threads: 0, costUsd: 0 };
  }
  const funded = await clientForUser(project.userId);
  const ctx: FetchContext = { projectId, funded, maxAgeMs };
  const policy = threadPolicyFor(scanSettings.settings.threads);

  let threads = 0;
  let costUsd = 0;
  const seen: Seen[] = [];
  const opened: StoredPost[] = [];
  // One phrasing at a time: its own threads already fill the job's share of
  // Reddit calls, and each writes a progress line of its own.
  for (const [index, phrasing] of settings.phrasings.entries()) {
    await writeProgress(
      jobId,
      `Searching ${index + 1} of ${settings.phrasings.length}: ${phrasing}`,
    );
    const done = await refreshPhrasing(project, ctx, policy, phrasing);
    threads += done.threads;
    costUsd += done.costUsd;
    seen.push(...done.seen);
    opened.push(...done.opened);
  }

  await writeProgress(jobId, "Reading who is asking in each thread");
  await judgeUnseen(project, seen);

  await writeProgress(jobId, `Judging ${opened.length} threads against your product`);
  await judgeOpened(project, opened);

  await writeProgress(jobId, "Finished");
  await enqueueJob("seo_refresh", projectId, new Date(Date.now() + maxAgeMs));
  return { phrasings: settings.phrasings.length, threads, costUsd };
}
